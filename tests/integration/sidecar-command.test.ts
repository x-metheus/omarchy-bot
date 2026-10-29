import { expect, test } from "bun:test";
import path from "node:path";

async function resolveBinary(binary: string) {
  // Each child must load the module with a fresh environment; static imports cache it.
  const child = Bun.spawn([process.execPath, "-e", `const { sidecarCommand } = await import(${JSON.stringify(path.join(import.meta.dir, "helpers/sidecarCommand.ts"))}); console.log(JSON.stringify(sidecarCommand));`], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMARCHY_BOT_TEST_SIDECAR_BINARY: binary },
  });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("an explicit Sidecar binary is selected without a runtime wrapper", async () => {
  const result = await resolveBinary(process.execPath);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([process.execPath]);
});

test("a missing selected Sidecar binary gives build instructions instead of a source fallback", async () => {
  const result = await resolveBinary(path.join(import.meta.dir, "missing-sidecar-binary"));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("bun scripts/build-sidecar.ts");
  expect(result.stderr).toContain("OMARCHY_BOT_TEST_SIDECAR_BINARY");
});
