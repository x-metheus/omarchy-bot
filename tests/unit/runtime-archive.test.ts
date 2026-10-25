import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertNotRoot, extractRuntimeArchive, verifyChecksum } from "../../apps/cli/src/archive.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "runtime-archive-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("runtime archive", () => {
  test("refuses root before creating installation files", () => {
    expect(() => assertNotRoot(() => 0)).toThrow(/refuses to install as root/);
    expect(readdirSync(root)).toEqual([]);
    expect(() => assertNotRoot(() => 1000)).not.toThrow();
  });
});

test("checks sha256 sidecars before creating a destination", () => {
  const archive = path.join(root, "runtime.tar.zst");
  const checksum = `${archive}.sha256`;
  const destination = path.join(root, "runtime");
  writeFileSync(archive, "known archive bytes\n");
  writeFileSync(checksum, `${"0".repeat(64)}  runtime.tar.zst\n`);
  expect(() => verifyChecksum(archive, checksum)).toThrow(/checksum mismatch/);
  expect(existsSync(destination)).toBe(false);

  const expected = createHash("sha256").update("known archive bytes\n").digest("hex");
  for (const sidecar of [`${expected}  runtime.tar.zst\n`, `${expected} *runtime.tar.zst\n`, expected.toUpperCase()]) {
    writeFileSync(checksum, sidecar);
    expect(verifyChecksum(archive, checksum)).toBe(expected);
  }
  expect(existsSync(destination)).toBe(false);
});

test("extracts tar.zst with Bun and restores file permissions without external tools", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  const invoked = path.join(root, "invoked");
  mkdirSync(bin);
  for (const tool of ["tar", "zstd"]) {
    const shim = path.join(bin, tool);
    writeFileSync(shim, `#!/bin/sh\necho ${tool} >> '${invoked}'\nexit 1\n`);
    chmodSync(shim, 0o755);
  }
  const packed = await new Bun.Archive({
    "scripts/serve.sh": "#!/bin/sh\necho ok\n",
    "readme.txt": "runtime\n",
  }).bytes();
  writeFileSync(archive, Bun.zstdCompressSync(packed));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    extractRuntimeArchive(archive, destination);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  expect(existsSync(invoked)).toBe(false);
  expect(readFileSync(path.join(destination, "scripts/serve.sh"), "utf8")).toBe("#!/bin/sh\necho ok\n");
  expect(readFileSync(path.join(destination, "readme.txt"), "utf8")).toBe("runtime\n");
  expect(statSync(path.join(destination, "scripts/serve.sh")).mode & 0o777).toBe(0o755);
  expect(statSync(path.join(destination, "readme.txt")).mode & 0o777).toBe(0o644);
  expect(statSync(path.join(destination, "scripts")).mode & 0o777).toBe(0o755);
});

async function changedEntry(name: string, type = "0", mode = "000644 "): Promise<Buffer> {
  const bytes = Buffer.from(await new Bun.Archive({ "placeholder.txt": "payload\n" }).bytes());
  bytes.fill(0, 0, 100);
  bytes.write(name, 0, 100);
  bytes.write(mode, 100, 8);
  bytes.write(type, 156, 1);
  if (type === "1" || type === "2") bytes.write("../outside", 157, 100);
  bytes.fill(0x20, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return bytes;
}

test("rejects unsafe entry names and non-regular entries before writing payload", async () => {
  const safe = await new Bun.Archive({ "first.txt": "must not be written\n" }).bytes();
  for (const [name, type] of [
    ["../escape.txt", "0"], ["/absolute.txt", "0"], ["dir/../escape.txt", "0"],
    ["back\\slash.txt", "0"], ["", "0"],
    ["link", "2"], ["hardlink", "1"], ["fifo", "6"], ["device", "3"], ["block", "4"],
  ]) {
    const malicious = await changedEntry(name!, type!);
    const archive = path.join(root, "unsafe.tar.zst");
    const destination = path.join(root, "runtime");
    writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([safe.subarray(0, 1024), malicious])));
    expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
    expect(existsSync(destination) ? readdirSync(destination) : []).toEqual([]);
    expect(existsSync(path.join(root, "escape.txt"))).toBe(false);
    expect(() => lstatSync(path.join(destination, "link"))).toThrow();
  }
});

test("preserves executable files and ignores archive permission bits beyond executable", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  writeFileSync(archive, Bun.zstdCompressSync(await changedEntry("run", "0", "007711 ")));
  extractRuntimeArchive(archive, destination);
  expect(statSync(path.join(destination, "run")).mode & 0o7777).toBe(0o755);
});

test("rejects a destination symlink without touching its target", async () => {
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const destination = path.join(root, "runtime");
  symlinkSync(outside, destination);
  const archive = path.join(root, "runtime.tar.zst");
  writeFileSync(archive, Bun.zstdCompressSync(await changedEntry("payload.txt")));
  expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
  expect(readdirSync(outside)).toEqual([]);
});

test("extracts the packager's dot directory and safe symlinks", async () => {
  const staging = path.join(root, "staging");
  mkdirSync(path.join(staging, "scripts"), { recursive: true });
  writeFileSync(path.join(staging, "scripts/serve.sh"), "serve\n");
  symlinkSync("scripts/serve.sh", path.join(staging, "link"));
  const archive = path.join(root, "runtime.tar.zst");
  const result = Bun.spawnSync(["tar", "--zstd", "-cf", archive, "-C", staging, "."]);
  if (result.exitCode !== 0) {
    const directory = await changedEntry("./", "5");
    directory.fill(0, 124, 136);
    directory.write("00000000000", 124);
    directory.fill(32, 148, 156);
    directory.write(`${directory.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
    const file = await new Bun.Archive({ "scripts/serve.sh": "serve\n" }).bytes();
    writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([directory.subarray(0, 512), file])));
  }
  const destination = path.join(root, "runtime");
  extractRuntimeArchive(archive, destination);
  expect(readFileSync(path.join(destination, "scripts/serve.sh"), "utf8")).toBe("serve\n");
  if (result.exitCode === 0) expect(lstatSync(path.join(destination, "link")).isSymbolicLink()).toBe(true);
});

async function tarEntry(name: string, type: string, content = Buffer.alloc(0), link = "") {
  const header = (await changedEntry(name, type)).subarray(0, 512);
  header.fill(0, 157, 257);
  header.write(link, 157, 100);
  header.fill(0, 124, 136);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  header.fill(32, 148, 156);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

test("extracts safe symlinks and rejects escaping links and writing through links", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  for (const link of ["scripts/serve.sh", "../out", "/tmp/somewhere"]) {
    writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([await tarEntry("link", "2", Buffer.alloc(0), link), Buffer.alloc(1024)])));
    if (link === "scripts/serve.sh") {
      extractRuntimeArchive(archive, destination);
      expect(lstatSync(path.join(destination, "link")).isSymbolicLink()).toBe(true);
      rmSync(destination, { recursive: true });
    } else {
      expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
      expect(existsSync(destination)).toBe(false);
    }
  }
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([
    await tarEntry("link", "2", Buffer.alloc(0), "scripts"),
    await tarEntry("link/serve.sh", "0", Buffer.from("bad")), Buffer.alloc(1024),
  ])));
  expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
  expect(existsSync(destination)).toBe(false);
});

test("rejects symlink chains that escape before writing any entries", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([
    await tarEntry("readme.txt", "0", Buffer.from("must not be written\n")),
    await tarEntry("dir/up", "2", Buffer.alloc(0), ".."),
    await tarEntry("dir/out", "2", Buffer.alloc(0), "up/../sibling"),
    Buffer.alloc(1024),
  ])));
  expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(path.join(root, "sibling"))).toBe(false);
});

test("extracts a relative symlink to a file inside the destination", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([
    await tarEntry("inner/link", "2", Buffer.alloc(0), "../readme.txt"),
    await tarEntry("readme.txt", "0", Buffer.from("runtime\n")),
    Buffer.alloc(1024),
  ])));
  extractRuntimeArchive(archive, destination);
  const link = path.join(destination, "inner/link");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe("../readme.txt");
  expect(realpathSync(link)).toBe(path.join(destination, "readme.txt"));
  expect(readFileSync(link, "utf8")).toBe("runtime\n");
});

test("allows internal symlink chains and rejects chains beyond forty hops", async () => {
  const archive = path.join(root, "runtime.tar.zst");
  const destination = path.join(root, "runtime");
  for (const length of [2, 40, 41]) {
    const entries = [await tarEntry("readme.txt", "0", Buffer.from("runtime\n"))];
    for (let index = 0; index < length; index++) {
      entries.push(await tarEntry(`link${index}`, "2", Buffer.alloc(0), index + 1 === length ? "readme.txt" : `link${index + 1}`));
    }
    writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
    if (length <= 40) {
      extractRuntimeArchive(archive, destination);
      expect(readFileSync(path.join(destination, "link0"), "utf8")).toBe("runtime\n");
      rmSync(destination, { recursive: true });
    } else {
      expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
      expect(existsSync(destination)).toBe(false);
    }
  }
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([
    await tarEntry("link", "2", Buffer.alloc(0), "link"), Buffer.alloc(1024),
  ])));
  expect(() => extractRuntimeArchive(archive, destination)).toThrow(/unsafe/);
  expect(existsSync(destination)).toBe(false);
});

test("skips extended headers and applies the following PAX path", async () => {
  const record = "path=scripts/serve.sh\n";
  const length = record.length + 3;
  const entries = [];
  for (const type of ["g", "X", "L", "K"]) entries.push(await tarEntry("metadata", type));
  entries.push(await tarEntry("metadata", "x", Buffer.from(`${length} ${record}`)));
  entries.push(await tarEntry("placeholder", "0", Buffer.from("serve\n")));
  const archive = path.join(root, "runtime.tar.zst");
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  const destination = path.join(root, "runtime");
  extractRuntimeArchive(archive, destination);
  expect(readFileSync(path.join(destination, "scripts/serve.sh"), "utf8")).toBe("serve\n");
});
