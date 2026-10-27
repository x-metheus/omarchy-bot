import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER_ASSETS_RELEASE } from "./botComputerAssets.ts";

/**
 * Points a browser ELF at the bundle's own loader. The kernel reads
 * `PT_INTERP` by file offset; glibc also reads that string by virtual
 * address (`load_bias + p_vaddr`) and compares it while loading. The path
 * is therefore stored inside a mapped segment, not merely appended.
 *
 * Because the executable itself names the loader, Chromium's normal zygote,
 * renderer, and crash-handler re-exec of `/proc/self/exe` all start under the
 * bundled loader, and the ordinary Chromium sandbox stays enabled.
 *
 * shortcut: the recorded interpreter is absolute; reinstall from the unpatched
 * archive when moving the installed browser pack.
 */
function patchInterpreter(filePath: string, interpreter: string): boolean {
  const file = readFileSync(filePath);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.byteLength < 64 || view.getUint32(0, false) !== 0x7f454c46 || file[4] !== 2) {
    return false;
  }
  const littleEndian = file[5] === 1;
  const programOffset = Number(view.getBigUint64(32, littleEndian));
  const entrySize = view.getUint16(54, littleEndian);
  const entryCount = view.getUint16(56, littleEndian);
  if (entrySize < 56 || programOffset < 0) return false;
  const pathBytes = new TextEncoder().encode(`${interpreter}\0`);
  let interp = -1;
  let loadOffset = 0;
  let loadAddress = 0;
  let loadFileEnd = 0;
  let loadMemoryEnd = 0;
  let loadAlign = 0x1000;
  let maxFileEnd = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = programOffset + index * entrySize;
    if (entry + 56 > file.byteLength) return false;
    const type = view.getUint32(entry, littleEndian);
    if (type === 3) interp = entry;
    if (type !== 1) continue;
    const offset = Number(view.getBigUint64(entry + 8, littleEndian));
    const address = Number(view.getBigUint64(entry + 16, littleEndian));
    const fileSize = Number(view.getBigUint64(entry + 32, littleEndian));
    const memorySize = Number(view.getBigUint64(entry + 40, littleEndian));
    const align = Number(view.getBigUint64(entry + 48, littleEndian));
    const fileEnd = offset + fileSize;
    const memoryEnd = address + Math.max(fileSize, memorySize);
    if (fileEnd > maxFileEnd) maxFileEnd = fileEnd;
    if (memoryEnd >= loadMemoryEnd) {
      loadOffset = offset;
      loadAddress = address;
      loadFileEnd = fileEnd;
      loadMemoryEnd = memoryEnd;
      if (align >= 0x1000) loadAlign = align;
    }
  }
  // A later load would be dropped, and bytes past the file size are section
  // headers that must not initialize the BSS.
  if (interp < 0 || loadFileEnd === 0 || maxFileEnd !== loadFileEnd) return false;
  const memoryExtent = loadOffset + (loadMemoryEnd - loadAddress);
  const placement = Math.ceil(memoryExtent / loadAlign) * loadAlign;
  if (placement < loadFileEnd) return false;
  // The kernel maps whole pages. A short final page reads past the file and
  // fails the exec, so the span is rounded up and fully backed.
  const span = Math.ceil(pathBytes.byteLength / loadAlign) * loadAlign;
  const patched = new Uint8Array(placement + span);
  patched.set(file.subarray(0, Math.min(file.byteLength, loadFileEnd)));
  patched.set(pathBytes, placement);
  const patchedView = new DataView(patched.buffer);
  const address = BigInt(loadAddress + (placement - loadOffset));
  patchedView.setBigUint64(interp + 8, BigInt(placement), littleEndian);
  patchedView.setBigUint64(interp + 16, address, littleEndian);
  patchedView.setBigUint64(interp + 32, BigInt(pathBytes.byteLength), littleEndian);
  patchedView.setBigUint64(interp + 40, BigInt(pathBytes.byteLength), littleEndian);
  // Grow the segment that contains the string so the address glibc reads is mapped.
  let extended = false;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = programOffset + index * entrySize;
    if (patchedView.getUint32(entry, littleEndian) !== 1) continue;
    const offset = Number(patchedView.getBigUint64(entry + 8, littleEndian));
    if (offset !== loadOffset) continue;
    const fileSize = BigInt(placement - loadOffset + span);
    const memorySize = patchedView.getBigUint64(entry + 40, littleEndian);
    patchedView.setBigUint64(entry + 32, fileSize, littleEndian);
    if (memorySize < fileSize) patchedView.setBigUint64(entry + 40, fileSize, littleEndian);
    const flags = patchedView.getUint32(entry + 4, littleEndian);
    patchedView.setUint32(entry + 4, flags | 4, littleEndian);
    extended = true;
  }
  if (!extended) return false;
  writeFileSync(filePath, patched, { mode: 0o755 });
  return true;
}

/**
 * The launcher only supplies the library search path: the browser ELF already
 * names the bundled loader, so Chromium's own child processes start correctly
 * without any command-prefix rewriting and without `--no-zygote`.
 */
function browserShim(): string {
  return [
    "#!/bin/sh",
    "here=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "LD_LIBRARY_PATH=\"$here/libs\"",
    "export LD_LIBRARY_PATH",
    "exec \"$here/chrome-linux64/chrome\" \"$@\"",
    "",
  ].join("\n");
}

/** Patch only once the final installation path is known. */
export function prepareBrowserPack(directory: string, destination: string): void {
  if (readFileSync(path.join(directory, ".omarchy-bot-browser-pack"), "utf8") !== `${BROWSER_ASSETS_RELEASE}\n`) throw new Error("browser pack version mismatch");
  const loader = path.join(directory, "libs", "ld-linux-x86-64.so.2");
  chmodSync(loader, 0o755);
  for (const binary of ["chrome", "chrome_crashpad_handler"]) {
    const candidate = path.join(directory, "chrome-linux64", binary);
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      if (binary === "chrome") throw new Error("browser pack has no chrome executable");
      continue;
    }
    chmodSync(candidate, 0o755);
    if (!patchInterpreter(candidate, path.join(destination, "libs", "ld-linux-x86-64.so.2"))) throw new Error(`${binary} does not name a dynamic loader to redirect`);
  }
  writeFileSync(path.join(directory, "browser"), browserShim(), { mode: 0o755 });
  writeFileSync(path.join(directory, ".omarchy-bot-assets"), `${BROWSER_ASSETS_RELEASE}\n`, { mode: 0o644 });
}
