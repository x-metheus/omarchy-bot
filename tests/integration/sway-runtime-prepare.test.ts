import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "../..");
const prepare = path.join(projectRoot, "scripts/sway-runtime/prepare.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-prepare-"));
  roots.push(root);
  const payload = path.join(root, "payload");
  mkdirSync(payload);
  writeFileSync(path.join(payload, "payload.txt"), "Sway fixture payload\n");
  const archive = path.join(root, "bundle.tar.gz");
  const archived = Bun.spawnSync(["tar", "-czf", archive, "-C", payload, "."]);
  expect(archived.exitCode).toBe(0);
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pin = path.join(root, "swayRuntimeSupply.ts");
  writeFileSync(pin, `export const SWAY_RUNTIME_RELEASE = "sway-fixture-v1";\nexport const SWAY_RUNTIME_BUNDLE = { sha256: "${sha256}" };\n`);
  return { root, archive, bytes, sha256, pin, destination: path.join(root, "sway") };
}

test("prepares a checksum-verified local Sway bundle with its ready marker without changing the archive", () => {
  const fixture = createFixture();
  const prepared = Bun.spawnSync(["bash", prepare, fixture.archive, fixture.pin], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (prepared.exitCode !== 0) throw new Error(prepared.stderr.toString());
  expect(readFileSync(path.join(fixture.destination, "payload.txt"), "utf8"))
    .toBe("Sway fixture payload\n");
  expect(readFileSync(path.join(fixture.destination, ".omarchy-bot-runtime"), "utf8"))
    .toBe(`sway-fixture-v1\n${fixture.sha256}\n`);
  expect(readFileSync(fixture.archive)).toEqual(fixture.bytes);
});

test("refuses an unpinned local Sway archive before extracting or writing a ready marker", () => {
  const fixture = createFixture();
  writeFileSync(fixture.pin, `export const SWAY_RUNTIME_RELEASE = "sway-fixture-v1";\nexport const SWAY_RUNTIME_BUNDLE = { sha256: "${"0".repeat(64)}" };\n`);
  const prepared = Bun.spawnSync(["bash", prepare, fixture.archive, fixture.pin], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(prepared.exitCode).not.toBe(0);
  expect(prepared.stderr.toString()).toContain("Sway bundle checksum mismatch");
  expect(existsSync(path.join(fixture.destination, ".omarchy-bot-runtime"))).toBe(false);
  expect(existsSync(fixture.destination)).toBe(false);
  expect(readFileSync(fixture.archive)).toEqual(fixture.bytes);
});

test("refuses to replace an archive occupying the prepared directory path", () => {
  const fixture = createFixture();
  renameSync(fixture.archive, fixture.destination);
  const prepared = Bun.spawnSync(["bash", prepare, fixture.destination, fixture.pin], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(prepared.exitCode).not.toBe(0);
  expect(existsSync(path.join(fixture.destination, ".omarchy-bot-runtime"))).toBe(false);
  expect(readFileSync(fixture.destination)).toEqual(fixture.bytes);
});
