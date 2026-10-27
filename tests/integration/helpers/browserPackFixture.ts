import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
/** A stored-entry ZIP, which is all the fixture browser archive needs. */
export function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const directories: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);
    locals.push(local);

    const directory = new Uint8Array(46 + nameBytes.byteLength);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(10, 0, true);
    directoryView.setUint32(20, data.byteLength, true);
    directoryView.setUint32(24, data.byteLength, true);
    directoryView.setUint16(28, nameBytes.byteLength, true);
    directoryView.setUint32(42, offset, true);
    directory.set(nameBytes, 46);
    directories.push(directory);
    offset += local.byteLength;
  }
  const directorySize = directories.reduce((total, entry) => total + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, directories.length, true);
  endView.setUint16(10, directories.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Uint8Array(Bun.concatArrayBuffers([...locals, ...directories, end]));
}

/** A single-member Debian package carrying one regular file. */
export function deb(member: string, content: string, mode = "0000644"): Uint8Array {
  const data = new TextEncoder().encode(content);
  const name = new TextEncoder().encode(member);
  const header = new Uint8Array(512);
  header.set(name, 0);
  header.set(new TextEncoder().encode(`${data.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  header.set(new TextEncoder().encode(mode), 100);
  header.set(new TextEncoder().encode("0"), 156);
  const headerChecksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(new TextEncoder().encode(`${headerChecksum.toString(8).padStart(6, "0")}\0 `), 148);
  const tar = Bun.concatArrayBuffers([
    header,
    data,
    new Uint8Array((512 - (data.byteLength % 512)) % 512),
    new Uint8Array(1024),
  ]);
  const compressed = Bun.zstdCompressSync(tar);

  const records: Uint8Array[] = [];
  const record = (name: string, body: Uint8Array): Uint8Array => {
    const padded = body.byteLength % 2 === 0
      ? body
      : Bun.concatArrayBuffers([body, new Uint8Array(1)]);
    const arHeader = new Uint8Array(60);
    const encoded = new TextEncoder().encode(name.padEnd(16, " "));
    arHeader.set(encoded.subarray(0, 16), 0);
    arHeader.set(new TextEncoder().encode(String(body.byteLength).padStart(10, " ")), 48);
    arHeader.set(new TextEncoder().encode("`\n"), 58);
    return new Uint8Array(Bun.concatArrayBuffers([arHeader, padded]));
  };
  records.push(record("debian-binary", new TextEncoder().encode("2.0\n")));
  records.push(record("data.tar.zst", compressed));
  return new Uint8Array(Bun.concatArrayBuffers([
    new TextEncoder().encode("!<arch>\n"),
    ...records,
  ]));
}

/** Real small ELF and its loader/libc: --version must execute successfully in installer fixtures. */
export function runnableBrowserFiles(): Record<string, Uint8Array> {
  const loader = realpathSync(interpreterPath("/usr/bin/printf").path!);
  return {
    "chrome-linux64/chrome": readFileSync("/usr/bin/printf"),
    "libs/ld-linux-x86-64.so.2": readFileSync(loader),
    "libs/libc.so.6": readFileSync(path.join(path.dirname(loader), "libc.so.6")),
  };
}

/**
 * Minimal ELF64 executable: one readable load segment holding the original
 * `/lib64/...` interpreter path. Patching must keep the replacement path
 * inside that mapped segment, because glibc reads it by virtual address.
 */
export function elfFixture(): Uint8Array {
  const pathBytes = new TextEncoder().encode("/lib64/ld-linux-x86-64.so.2\0");
  const fileSize = 0x2000 + pathBytes.byteLength;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 62, true);
  // The entry is the ret at the load address. A file offset is not mapped.
  view.setBigUint64(24, 0x401000n, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true);
  // Load starts at the second page. Offset 0 holds the headers, which the
  // kernel maps on its own and rejects inside a load segment.
  view.setUint32(64, 1, true);
  view.setUint32(68, 5, true);
  view.setBigUint64(64 + 8, 0x1000n, true);
  view.setBigUint64(64 + 16, 0x401000n, true);
  view.setBigUint64(64 + 32, BigInt(fileSize - 0x1000), true);
  // Extra memory past the file is the BSS. The patched path must start after it.
  view.setBigUint64(64 + 40, BigInt(fileSize - 0x1000 + 0x2000), true);
  view.setBigUint64(64 + 48, 0x1000n, true);
  view.setUint32(64 + 56, 3, true);
  view.setBigUint64(64 + 56 + 8, 0x2000n, true);
  view.setBigUint64(64 + 56 + 16, 0x402000n, true);
  view.setBigUint64(64 + 56 + 32, BigInt(pathBytes.byteLength), true);
  view.setBigUint64(64 + 56 + 40, BigInt(pathBytes.byteLength), true);
  bytes.set(pathBytes, 0x2000);
  bytes[0x1000] = 0xc3;
  return bytes;
}

export function interpreterPath(file: string): { path?: string; offset?: number; mapped: boolean } {
  const bytes = readFileSync(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[5] === 1;
  const programOffset = Number(view.getBigUint64(32, littleEndian));
  const entrySize = view.getUint16(54, littleEndian);
  const entryCount = view.getUint16(56, littleEndian);
  let offset = -1;
  let address = -1;
  let size = 0;
  const loads: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    const entry = programOffset + index * entrySize;
    const type = view.getUint32(entry, littleEndian);
    if (type === 1) {
      const start = Number(view.getBigUint64(entry + 16, littleEndian));
      const memory = Number(view.getBigUint64(entry + 40, littleEndian));
      loads.push({ start, end: start + memory });
    }
    if (type !== 3) continue;
    offset = Number(view.getBigUint64(entry + 8, littleEndian));
    address = Number(view.getBigUint64(entry + 16, littleEndian));
    size = Number(view.getBigUint64(entry + 32, littleEndian));
  }
  if (offset < 0) return { mapped: false };
  return {
    path: bytes.subarray(offset, offset + size - 1).toString(),
    offset,
    mapped: loads.some((load) => address >= load.start && address + size <= load.end),
  };
}

