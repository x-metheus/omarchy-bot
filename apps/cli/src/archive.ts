import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function assertNotRoot(getuid: () => number = () => process.getuid!()): void {
  if (getuid() === 0) throw new Error("omarchy-bot refuses to install as root");
}

export function verifyChecksum(archivePath: string, checksumPath: string): string {
  const expected = /^([a-f\d]{64})(?:[ \t]+\*?[^\r\n]+)?$/i.exec(readFileSync(checksumPath, "utf8").trim())?.[1]?.toLowerCase();
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (expected !== actual) throw new Error("runtime archive checksum mismatch");
  return actual;
}

export function extractRuntimeArchive(archivePath: string, destination: string): void {
  const bytes = Buffer.from(Bun.zstdDecompressSync(readFileSync(archivePath)));
  const target = path.resolve(destination);
  const entries = new Map<string, { directory: boolean; mode: number; content: Buffer; link?: string }>();
  const unsafe = (): never => { throw new Error("unsafe runtime archive or destination"); };
  const octal = (field: Buffer): number => {
    const value = field.toString("ascii").replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(value)) return unsafe();
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) return unsafe();
    return number;
  };
  const nameField = (field: Buffer): string => {
    const end = field.indexOf(0);
    if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) return unsafe();
    return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
  };

  let offset = 0;
  let paxPath: string | undefined;
  for (; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.subarray(offset).some((byte) => byte !== 0)) unsafe();
      break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) unsafe();
    const name = nameField(header.subarray(0, 100));
    const prefix = nameField(header.subarray(345, 500));
    const type = header[156];
    const size = octal(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > bytes.length) unsafe();
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    offset = next;
    if ([120, 103, 88, 76, 75].includes(type!)) {
      if ([120, 103, 88].includes(type!)) {
        for (let index = 0; index < content.length;) {
          const space = content.indexOf(32, index);
          const length = Number(content.subarray(index, space).toString());
          if (space < index || !Number.isSafeInteger(length) || length <= space - index + 1 || index + length > content.length) unsafe();
          const record = content.subarray(space + 1, index + length - 1).toString("utf8");
          if (record.startsWith("path=")) paxPath = record.slice(5);
          index += length;
        }
      }
      continue;
    }
    const fullName = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    if (!name || fullName.includes("\\") || path.posix.isAbsolute(fullName) || path.win32.isAbsolute(fullName)
      || fullName.split("/").includes("..")) unsafe();
    const relative = path.posix.normalize(fullName).replace(/\/$/, "");
    const resolved = path.resolve(target, relative);
    if (relative === "." && type === 53 && size === 0) continue;
    if (relative === "." || !resolved.startsWith(`${target}${path.sep}`)) unsafe();
    if (type !== 0 && type !== 48 && type !== 53 && type !== 50) unsafe();
    const directory = type === 53;
    const mode = octal(header.subarray(100, 108));
    if (directory && size !== 0) unsafe();
    const link = type === 50 ? nameField(header.subarray(157, 257)) : undefined;
    if (link !== undefined && (!link || path.isAbsolute(link) || path.win32.isAbsolute(link) || link.includes("\\"))) unsafe();
    const previous = entries.get(relative);
    if (previous && (!directory || !previous.directory)) unsafe();
    entries.set(relative, {
      directory,
      mode: directory || relative.endsWith(".sh") || (mode & 0o111) !== 0 ? 0o755 : 0o644,
      content,
      ...(link === undefined ? {} : { link }),
    });
  }
  if (offset + 1024 > bytes.length) unsafe();
  for (const name of entries.keys()) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (entries.has(parent) && !entries.get(parent)!.directory) unsafe();
    }
  }
  for (const [name, entry] of entries) {
    if (entry.link === undefined) continue;
    const resolved = name.split("/").slice(0, -1);
    const pending = entry.link.split("/").reverse();
    let hops = 1;
    while (pending.length > 0) {
      const component = pending.pop()!;
      if (component === "" || component === ".") continue;
      if (component === "..") {
        if (resolved.length === 0) unsafe();
        resolved.pop();
        continue;
      }
      resolved.push(component);
      const link = entries.get(resolved.join("/"))?.link;
      if (link !== undefined) {
        if (++hops > 40) unsafe();
        resolved.pop();
        const components = link.split("/");
        for (let index = components.length - 1; index >= 0; index--) pending.push(components[index]!);
      }
    }
  }
  // Refuse existing symlinks along the entire destination path before making directories.
  for (let parent = target;; parent = path.dirname(parent)) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) unsafe();
    if (parent === path.dirname(parent)) break;
  }
  if (existsSync(target) && readdirSync(target).length !== 0) unsafe();
  mkdirSync(target, { recursive: true, mode: 0o755 });
  try {
    chmodSync(target, 0o755);
    for (const [name, entry] of entries) {
      const output = path.resolve(target, name);
      const directory = entry.directory ? output : path.dirname(output);
      for (let current = directory;; current = path.dirname(current)) {
        const stat = lstatSync(current, { throwIfNoEntry: false });
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) unsafe();
        if (current === target) break;
      }
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      for (let current = directory; current !== target; current = path.dirname(current)) chmodSync(current, 0o755);
      if (!entry.directory) {
        if (entry.link !== undefined) symlinkSync(entry.link, output);
        else {
          writeFileSync(output, entry.content, { flag: "wx", mode: entry.mode });
          chmodSync(output, entry.mode);
        }
      }
    }
  } catch (error) {
    for (const child of readdirSync(target)) rmSync(path.join(target, child), { recursive: true, force: true });
    throw error;
  }
}
