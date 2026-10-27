import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
function isFile(candidate: string): boolean { return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false; }
/** Writes one archive member below `destination`, refusing traversal. */
function writeMember(
  destination: string,
  member: string,
  bytes: Uint8Array,
  mode?: number,
): void {
  const target = path.resolve(destination, member);
  if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) {
    throw new Error(`archive member escapes its destination: ${member}`);
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(target, mode);
}

/**
 * Reads a ZIP central directory and inflates each entry. Bun's archive reader
 * handles tar but not ZIP, and a browser download is the only ZIP this module
 * needs, so the two ZIP methods it can contain (stored and deflate) are
 * decoded here instead of adding a dependency.
 */
export function extractZip(archivePath: string, destination: string): void {
  const archive = new Uint8Array(readFileSync(archivePath));
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error(`${path.basename(archivePath)} is not a ZIP archive`);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`${path.basename(archivePath)} has a corrupt central directory`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`${path.basename(archivePath)} has a corrupt local header for ${name}`);
    }
    const dataStart = localOffset
      + 30
      + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) writeMember(destination, name, data);
    else if (method === 8) writeMember(destination, name, inflateRawSync(data));
    else throw new Error(`${name} uses unsupported ZIP compression method ${method}`);
  }
}

/**
 * Unpacks the ELF libraries from a Debian package's `data.tar.zst` member into
 * a flat directory. Debian's `ar` container is a flat record list of
 * length-prefixed records, so every read is bounds-checked before it happens.
 *
 * Packaging splits a library into a real file (`ld-2.39.so`) plus symlinks
 * (`ld-linux-x86-64.so.2`), but the browser's loader needs the symlink names,
 * so each link is materialized as a copy of the file it points to.
 */
export function extractDeb(archivePath: string, destination: string): void {
  const archive = new Uint8Array(readFileSync(archivePath));
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (archive.byteLength < 8 || view.getBigUint64(0, false) !== 0x213c617263683e0an) {
    throw new Error(`${path.basename(archivePath)} is not a Debian package`);
  }
  let offset = 8;
  while (offset + 60 <= archive.byteLength) {
    const name = new TextDecoder().decode(archive.subarray(offset, offset + 16)).trimEnd();
    const size = Number(
      new TextDecoder().decode(archive.subarray(offset + 48, offset + 58)).trim(),
    );
    const start = offset + 60;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > archive.byteLength) {
      throw new Error(`${path.basename(archivePath)} has a truncated ${name} member`);
    }
    if (name.startsWith("data.tar")) {
      if (!name.endsWith(".zst")) {
        throw new Error(`${path.basename(archivePath)} must use a zstd data member`);
      }
      extractLibraries(Bun.zstdDecompressSync(archive.subarray(start, end)), destination);
      return;
    }
    offset = end + (size % 2);
  }
  throw new Error(`${path.basename(archivePath)} has no data.tar.zst member`);
}

/** `<any>/lib/x86_64-linux-gnu/<name>` or `.../nss/<name>`, `.../pulseaudio/<name>`. */
const LIBRARY_MEMBER =
  /(?:^|\/)lib\/x86_64-linux-gnu\/(?:nss\/|pulseaudio\/)?([^/]+)$/;

function extractLibraries(tar: Uint8Array, destination: string): void {
  const links = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const size = Number.parseInt(tarString(header.subarray(124, 136)) || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const linkName = tarString(header.subarray(157, 257));
    const mode = Number.parseInt(tarString(header.subarray(100, 108)) || "0", 8);
    offset += 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.byteLength) {
      throw new Error(`library archive has a truncated ${prefix}/${name} member`);
    }
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const member = LIBRARY_MEMBER.exec(prefix === "" ? name : `${prefix}/${name}`);
    if (member === null) continue;
    const library = member[1] as string;
    if (type === "2") links.set(library, path.basename(linkName));
    else if (type === "0" || type === "\0") {
      writeMember(destination, library, data, mode === 0 ? undefined : mode);
    }
  }
  for (const [library, target] of links) {
    const resolved = path.join(destination, target);
    if (!isFile(resolved)) continue;
    writeMember(destination, library, readFileSync(resolved), 0o755);
  }
}

function tarString(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}
