import { afterEach, describe, expect, spyOn, test } from "bun:test";
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


describe("portable Bot Computer assets", () => {
  test("resolves the installed browser pack without network and reports an actionable missing pack", async () => {
    const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("runtime network forbidden"));
    const profileDir = temporaryProfile();
    const browserPackDir = path.join(root!, "installed-browser");
    const supply = new PortableBotComputerAssets({ profileDir, browserPackDir });
    await expect(supply.ensureBrowser()).rejects.toThrow("omarchy-bot update");
    mkdirSync(path.join(browserPackDir, "chrome-linux64"), { recursive: true });
    mkdirSync(path.join(browserPackDir, "libs"));
    writeFileSync(path.join(browserPackDir, ".omarchy-bot-assets"), "chrome-for-testing-156.0.8078.47-linux64\n");
    for (const file of ["browser", "chrome-linux64/chrome", "libs/ld-linux-x86-64.so.2"]) {
      writeFileSync(path.join(browserPackDir, file), "fixture", { mode: 0o755 });
    }
    expect(await supply.ensureBrowser()).toEqual({ browserBin: path.join(browserPackDir, "browser") });
    const chrome = path.join(browserPackDir, "chrome-linux64/chrome");
    writeFileSync(chrome, "");
    await expect(supply.ensureBrowser()).rejects.toThrow("--browser-pack");
    writeFileSync(chrome, "fixture");
    writeFileSync(path.join(browserPackDir, ".omarchy-bot-assets"), "older-pin\n");
    await expect(supply.ensureBrowser()).rejects.toThrow("omarchy-bot update");
    expect(existsSync(profileDir)).toBe(false);
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
  test("resolves verified runtime fonts offline and keeps cache in the profile", async () => {
    const profileDir = temporaryProfile();
    const fontDir = path.join(root!, "fonts");
    mkdirSync(fontDir);
    const bytes = new TextEncoder().encode("fixture-font");
    writeFileSync(path.join(fontDir, "Fixture.ttf"), bytes);
    const supply = new PortableBotComputerAssets({ profileDir, fontDir, fonts: [{
      name: "fixture", file: "Fixture.ttf", url: "https://fixture.invalid/font", sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    }] });
    const { fontConfigFile } = await supply.ensureFonts();
    const config = readFileSync(fontConfigFile, "utf8");
    expect(config).toContain(`<dir>${fontDir}</dir>`);
    expect(config).toContain(`<cachedir>${path.join(profileDir, "assets/font-cache")}</cachedir>`);
    const mtime = statSync(fontConfigFile).mtimeMs;
    await supply.ensureFonts();
    expect(statSync(fontConfigFile).mtimeMs).toBe(mtime);
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
