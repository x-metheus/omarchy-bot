import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const prepare = path.resolve(import.meta.dir, "../../scripts/prepare-fonts.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(tampered = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-font-prepare-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const bytes = "fixture font bytes";
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const source = path.join(root, "font-bytes");
  writeFileSync(source, bytes);
  const curl = path.join(bin, "curl");
  writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; fi
  shift
done
cp "$FONT_FIXTURE_BYTES" "$output"
`);
  chmodSync(curl, 0o700);
  const pin = path.join(root, "botComputerAssets.ts");
  writeFileSync(pin, `export const FONT_ASSETS: readonly FontAsset[] = Object.freeze([
  { file: "Fixture[wdth,wght].ttf", url: "https://assets.invalid/latin.ttf", sha256: "${sha256}" },
  { file: "FixtureCJK[wght].ttf", url: "https://assets.invalid/cjk.ttf", sha256: "${tampered ? "0".repeat(64) : sha256}" },
]);
export const OTHER = { file: "Wrong.ttf", url: "https://assets.invalid/wrong.ttf", sha256: "${"0".repeat(64)}" };
`);
  const out = path.join(root, "prepared");
  return {
    out,
    run: () => Bun.spawnSync(["bash", prepare, out, pin], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FONT_FIXTURE_BYTES: source },
      stdout: "pipe", stderr: "pipe",
    }),
  };
}

test("prepares all pinned fonts from verified bytes without a font manifest or marker", () => {
  const f = fixture();
  const result = f.run();
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  for (const file of ["Fixture[wdth,wght].ttf", "FixtureCJK[wght].ttf"]) {
    expect(readFileSync(path.join(f.out, file), "utf8")).toBe("fixture font bytes");
  }
  expect(existsSync(path.join(f.out, "Wrong.ttf"))).toBe(false);
});

test("refuses mismatched prepared fonts before publishing any files", () => {
  const f = fixture(true);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(path.join(f.out, "FixtureCJK[wght].ttf"));
  expect(result.stderr.toString()).toContain(`expected ${"0".repeat(64)}`);
  expect(result.stderr.toString()).toContain("received ");
  expect(existsSync(path.join(f.out, "Fixture[wdth,wght].ttf"))).toBe(false);
});
