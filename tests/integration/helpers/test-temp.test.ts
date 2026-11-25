import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimTestTempRun, sweepStaleTestRuns, TEST_TEMP_RUN_ENV } from "./test-temp.ts";

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "test-temp-"));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("the sweep removes runs whose process is gone or that are a day old, and keeps live runs", () => {
  const { root, close } = scratch();
  try {
    const now = Date.now();
    const make = (name: string, ageMs = 0) => {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, "leftover"), { recursive: true });
      const at = (now - ageMs) / 1000;
      utimesSync(dir, at, at);
      return dir;
    };
    const dead = make("111");
    const live = make("222");
    const liveButOld = make("333", 25 * 60 * 60 * 1000);
    const unrelated = make("not-a-run", 48 * 60 * 60 * 1000);
    writeFileSync(path.join(root, "444"), "a file, not a run folder");
    const removed = sweepStaleTestRuns(root, now, (pid) => pid !== 111);
    expect(removed.sort()).toEqual([dead, liveButOld].sort());
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(path.join(root, "444"))).toBe(true);
    expect(sweepStaleTestRuns(path.join(root, "missing"), now)).toEqual([]);
  } finally { close(); }
});

test("a run claims its own folder, points TMPDIR at it, and nested runs reuse the parent's", () => {
  const { root, close } = scratch();
  try {
    const stale = path.join(root, "999999999");
    mkdirSync(stale, { recursive: true });
    const exits: (() => void)[] = [];
    const env: Record<string, string | undefined> = {};
    const run = claimTestTempRun({ env, root, onExit: (fn) => exits.push(fn) });
    expect(run).toBe(path.join(root, String(process.pid)));
    expect(env.TMPDIR).toBe(run);
    expect(env[TEST_TEMP_RUN_ENV]).toBe(run);
    expect(existsSync(stale)).toBe(false);
    // A nested `bun test` inherits the parent's run folder instead of claiming another.
    expect(claimTestTempRun({ env, root, onExit: (fn) => exits.push(fn) })).toBeUndefined();
    expect(exits).toHaveLength(1);
    writeFileSync(path.join(run!, "file"), "x");
    exits[0]!();
    expect(existsSync(run!)).toBe(false);
  } finally { close(); }
});

test("a child bun test inherits the run folder and leaves nothing behind after it exits", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "test-temp-child-"));
  try {
    const marker = path.join(dir, "marker.test.ts");
    const out = path.join(dir, "seen.txt");
    writeFileSync(marker, `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\nimport os from "node:os";\ntest("records tmpdir", () => { writeFileSync(${JSON.stringify(out)}, os.tmpdir()); });\n`);
    const result = Bun.spawnSync([process.execPath, "test", marker], { cwd: path.resolve(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    // This process already owns a run folder, so the child reuses it.
    expect(realpathSync(readFileSync(out, "utf8"))).toBe(realpathSync(process.env[TEST_TEMP_RUN_ENV]!));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
