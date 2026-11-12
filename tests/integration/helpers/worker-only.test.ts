import { expect, test } from "bun:test";
import { workerOnly } from "./harness.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("workerOnly rejects empty reasons", () => {
  expect(() => workerOnly("  ")).toThrow();
});

test("workerOnly runs on the worker path and reports Task 20 when durable skips it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-only-"));
  try {
    const file = path.join(dir, "marker.test.ts");
    const helper = path.join(import.meta.dir, "harness.ts");
    writeFileSync(file, `import { expect } from "bun:test";\nimport { workerOnly } from ${JSON.stringify(helper)};\nworkerOnly("worker session ids")("marker fixture", () => { expect(1).toBe(2); });\n`);
    for (const value of ["0", "1"]) {
      const result = Bun.spawnSync([process.execPath, "test", file], { env: { ...process.env, OMARCHY_TEST_DURABLE: value }, stdout: "pipe", stderr: "pipe" });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode).toBe(value === "1" ? 0 : 1);
      expect(output).toContain(value === "1" ? "1 skip" : "1 fail");
      expect(output).toContain("Task 20: worker session ids");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
