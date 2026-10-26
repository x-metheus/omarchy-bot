import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PortableBotComputerAssets,
  type FontAsset,
  type PinnedAsset,
} from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function temporaryProfile(): string {
  root = mkdtempSync(path.join(os.tmpdir(), "bot-computer-assets-"));
  return path.join(root, "computer");
}

function hash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** A stored-entry ZIP, which is all the fixture browser archive needs. */
function zip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const directories: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
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
function deb(member: string, content: string, mode = "0000644"): Uint8Array {
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

/**
 * Minimal ELF64 executable: one readable load segment holding the original
 * `/lib64/...` interpreter path. Patching must keep the replacement path
 * inside that mapped segment, because glibc reads it by virtual address.
 */
function elfFixture(): string {
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
  return [...bytes].map((byte) => String.fromCharCode(byte)).join("");
}

function interpreterPath(file: string): { path?: string; offset?: number; mapped: boolean } {
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

function served(bytes: Uint8Array, url: string): PinnedAsset {
  return { name: url, url, sha256: hash(bytes) };
}

describe("portable Bot Computer assets", () => {
  test("resolves verified runtime fonts offline and provisions the browser from verified downloads", async () => {
    const profileDir = temporaryProfile();
    const browserBytes = zip({
      "chrome-linux64/chrome": elfFixture(),
      "chrome-linux64/icudtl.dat": "fixture",
    });
    const browser = served(browserBytes, "https://assets.invalid/browser.zip");
    // The kernel executes the loader, so publication must keep it executable.
    const libraryBytes = deb(
      "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
      "fixture-loader",
    );
    const library = served(libraryBytes, "https://assets.invalid/library.deb");
    // Ubuntu keeps some runtime libs in a subdirectory of the multiarch path.
    const subdirBytes = deb(
      "usr/lib/x86_64-linux-gnu/pulseaudio/libpulsecommon-16.1.so",
      "fixture-subdir-library",
    );
    const subdirLibrary = served(subdirBytes, "https://assets.invalid/subdir.deb");
    const fontBytes = new TextEncoder().encode("font-bytes");
    const fonts: FontAsset[] = [{
      name: "fixture-font",
      file: "Fixture.ttf",
      url: "https://assets.invalid/font.ttf",
      sha256: hash(fontBytes),
    }];
    const fontDir = path.join(root!, "runtime", "fonts");
    mkdirSync(fontDir, { recursive: true });
    writeFileSync(path.join(fontDir, "Fixture.ttf"), fontBytes);
    const assetFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === browser.url) return new Response(browserBytes as BodyInit);
      if (url === library.url) return new Response(libraryBytes as BodyInit);
      if (url === subdirLibrary.url) return new Response(subdirBytes as BodyInit);
      throw new Error(`unexpected download: ${url}`);
    }) as unknown as typeof fetch;

    const supply = new PortableBotComputerAssets({
      profileDir,
      fontDir,
      browser,
      libraries: [library, subdirLibrary],
      fonts,
      fetch: assetFetch,
      platform: "linux",
      arch: "x64",
    });

    const { fontConfigFile } = await supply.ensureFonts();
    expect(fontConfigFile).toBe(path.join(profileDir, "assets", "fonts.conf"));
    expect(existsSync(path.join(profileDir, "assets", "fonts"))).toBe(false);
    const config = readFileSync(fontConfigFile, "utf8");
    expect(config).not.toContain("<include>");
    expect(config).toContain(`<dir>${fontDir}</dir>`);
    expect(config).toContain(`<cachedir>${path.join(profileDir, "assets", "font-cache")}</cachedir>`);

    const { browserBin } = await supply.ensureBrowser();
    expect(browserBin).toBe(path.join(profileDir, "assets", "browser-bundle", "browser"));
    expect(existsSync(browserBin)).toBe(true);
    const bundle = path.join(profileDir, "assets", "browser-bundle");
    const loader = path.join(bundle, "libs", "ld-linux-x86-64.so.2");
    // The loader is executed by the shim, so its package mode must survive extraction.
    expect((statSync(loader).mode & 0o111) !== 0).toBe(true);
    // A library packaged below the multiarch directory still lands in the flat libs/.
    expect(existsSync(path.join(bundle, "libs", "libpulsecommon-16.1.so"))).toBe(true);

    // The published browser ELF must name the bundle's own loader, and that
    // name must sit in a mapped segment: glibc reads it by virtual address.
    const chrome = path.join(bundle, "chrome-linux64", "chrome");
    const interpreter = interpreterPath(chrome);
    expect(interpreter.path).toBe(path.join(bundle, "libs", "ld-linux-x86-64.so.2"));
    expect(interpreter.mapped).toBe(true);
    const originalFileEnd = 0x2000 + "/lib64/ld-linux-x86-64.so.2\0".length;
    const bssEnd = originalFileEnd + 0x2000;
    expect(interpreter.offset).toBeGreaterThanOrEqual(bssEnd);
    const gap = readFileSync(chrome).subarray(originalFileEnd, interpreter.offset);
    expect(gap.every((byte) => byte === 0)).toBe(true);
    expect((statSync(interpreter.path as string).mode & 0o111) !== 0).toBe(true);
    // Linux will not run a script interpreter, so flag forwarding is the shim text.
    expect(readFileSync(browserBin, "utf8")).toContain(
      'exec "$here/chrome-linux64/chrome" "$@"',
    );

    // Second calls are no-ops: nothing is downloaded again.
    let requests = 0;
    const countingSupply = new PortableBotComputerAssets({
      profileDir,
      fontDir,
      browser,
      libraries: [library],
      fonts,
      fetch: (async () => {
        requests += 1;
        return new Response("unexpected");
      }) as unknown as typeof fetch,
      platform: "linux",
      arch: "x64",
    });
    const configMtime = statSync(fontConfigFile).mtimeMs;
    expect((await countingSupply.ensureFonts()).fontConfigFile).toBe(fontConfigFile);
    expect(statSync(fontConfigFile).mtimeMs).toBe(configMtime);
    expect((await countingSupply.ensureBrowser()).browserBin).toBe(browserBin);
    writeFileSync(fontConfigFile, "obsolete config");
    await countingSupply.ensureFonts();
    expect(readFileSync(fontConfigFile, "utf8")).toBe(config);
    expect(requests).toBe(0);
  });

  test("refuses a browser download whose bytes do not match the pin", async () => {
    const profileDir = temporaryProfile();
    const supply = new PortableBotComputerAssets({
      profileDir,
      browser: {
        name: "fixture-browser",
        url: "https://assets.invalid/browser.zip",
        sha256: "0".repeat(64),
      },
      libraries: [],
      fonts: [],
      fetch: (async () => new Response("tampered")) as unknown as typeof fetch,
      platform: "linux",
      arch: "x64",
    });

    await expect(supply.ensureBrowser()).rejects.toThrow("failed SHA-256 verification");
    expect(existsSync(path.join(profileDir, "assets", "browser-bundle"))).toBe(false);
  });

  test("rejects a non-HTTPS browser artifact before downloading", async () => {
    const supply = new PortableBotComputerAssets({
      profileDir: temporaryProfile(),
      browser: { name: "fixture-browser", url: "http://assets.invalid/browser.zip", sha256: "0".repeat(64) },
      libraries: [],
      fetch: async () => { throw new Error("must not download"); },
    });
    await expect(supply.ensureBrowser()).rejects.toThrow("must be downloaded over HTTPS");
  });

  test("refuses a runtime font whose bytes do not match the pin without fetching", async () => {
    const profileDir = temporaryProfile();
    const fontDir = path.join(root!, "fonts");
    mkdirSync(fontDir);
    const fontPath = path.join(fontDir, "Fixture.ttf");
    writeFileSync(fontPath, "tampered");
    const supply = new PortableBotComputerAssets({
      profileDir,
      fontDir,
      fonts: [{
        name: "fixture-font",
        file: "Fixture.ttf",
        url: "https://assets.invalid/font.ttf",
        sha256: "0".repeat(64),
      }],
      fetch: async () => { throw new Error("must not download"); },
    });

    await expect(supply.ensureFonts()).rejects.toThrow(`checksum mismatch at ${fontPath}`);
    expect(existsSync(path.join(profileDir, "assets", "fonts.conf"))).toBe(false);
  });

  test("reports a missing runtime font directory without fetching", async () => {
    const profileDir = temporaryProfile();
    const fontDir = path.join(root!, "missing-fonts");
    const supply = new PortableBotComputerAssets({
      profileDir,
      fontDir,
      fetch: async () => { throw new Error("must not download"); },
    });
    await expect(supply.ensureFonts()).rejects.toThrow(`directory is unavailable: ${fontDir}`);
    expect(existsSync(profileDir)).toBe(false);
  });

  test("builds assets lazily, so constructing a supply touches nothing", async () => {
    const profileDir = temporaryProfile();
    const supply = new PortableBotComputerAssets({ profileDir });
    expect(existsSync(profileDir)).toBe(false);
    void supply;
  });
});
