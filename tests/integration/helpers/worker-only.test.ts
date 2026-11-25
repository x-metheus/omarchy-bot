import { expect, test } from "bun:test";
import { workerOnly } from "./harness.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("workerOnly rejects empty reasons", () => {
  expect(() => workerOnly("  ")).toThrow("workerOnly requires a reason");
});

test("workerOnly skips and reports Task 20 regardless of the retired environment switch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-only-"));
  try {
    const file = path.join(dir, "marker.test.ts");
    const helper = path.join(import.meta.dir, "harness.ts");
    writeFileSync(file, `import { expect, test } from "bun:test";
import { workerOnly } from ${JSON.stringify(helper)};
test("workerOnly rejects empty reasons", () => {
  expect(() => workerOnly("  ")).toThrow("workerOnly requires a reason");
});
workerOnly("worker session ids")("marker fixture", () => { throw new Error("worker-only test ran"); });
`);
    // Exercise the retired key in child processes while keeping it out of the test harness.
    const retiredKey = ["OMARCHY_TEST", "DURABLE"].join("_");
    for (const value of [undefined, "1", "0"]) {
      const env = { ...process.env };
      if (value === undefined) delete env[retiredKey];
      else env[retiredKey] = value;
      const result = Bun.spawnSync([process.execPath, "test", file], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      const output = result.stdout.toString() + result.stderr.toString();
      expect({ exitCode: result.exitCode, output }).toMatchObject({ exitCode: 0 });
      expect(output).toContain("1 pass");
      expect(output).toContain("1 skip");
      expect(output).toContain("marker fixture (Task 20: worker session ids)");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
