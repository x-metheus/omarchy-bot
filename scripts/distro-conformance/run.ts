#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";
import matrix from "./matrix.json";
import { verifyChecksum } from "../../apps/cli/src/archive.ts";

const [id, input, browserInput] = process.argv.slice(2);
const distro = matrix.find(row => row.id === id);
assert(distro && input && browserInput, `Usage: bun scripts/distro-conformance/run.ts <${matrix.map(row => row.id).join("|")}> <runtime.tar.zst> <browser-pack.tar.zst>`);
const archive = path.resolve(input);
verifyChecksum(archive, `${archive}.sha256`);
const browserPack = path.resolve(browserInput);
verifyChecksum(browserPack, `${browserPack}.sha256`);
const repo = path.resolve(import.meta.dir, "../..");
const image = `omarchy-bot-distro-conformance:${distro.id}`;
async function run(args: string[]): Promise<void> {
  const child = Bun.spawn(["docker", ...args], { cwd: repo, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  assert.equal(await child.exited, 0, `${distro!.id}: docker ${args[0]} failed`);
}
// Use a prepared image offline; building is explicit and never pulls a base implicitly.
if (process.env.OMARCHY_BOT_DISTRO_BUILD === "1") {
  await run(["build", "--pull=false", "--build-arg", `DISTRO_IMAGE=${distro.image}`, "--build-arg", `FAMILY=${distro.family}`,
    "-f", "scripts/distro-conformance/Dockerfile", "-t", image, "."]);
}
const container = `omarchy-bot-distro-${distro.id}-${crypto.randomUUID()}`;
const remove = async (): Promise<void> => {
  await Bun.spawn(["docker", "rm", "--force", container], { stdout: "ignore", stderr: "ignore" }).exited;
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void remove().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}
try {
  await run(["run", "--name", container, "--rm", "--pull=never", "--init", "--network", "none",
    "--shm-size=1g", "--tmpfs", "/tmp:rw,exec,size=4g,mode=1777",
    // Chromium keeps its own sandbox; Docker's default seccomp denies its user namespaces.
    "--security-opt", "seccomp=unconfined",
    "--mount", `type=bind,src=${repo},dst=/src,readonly`,
    "--mount", `type=bind,src=${archive},dst=/bundle/runtime.tar.zst,readonly`,
    "--mount", `type=bind,src=${archive}.sha256,dst=/bundle/runtime.tar.zst.sha256,readonly`,
    "--mount", `type=bind,src=${browserPack},dst=/bundle/browser.tar.zst,readonly`,
    "--mount", `type=bind,src=${browserPack}.sha256,dst=/bundle/browser.tar.zst.sha256,readonly`, image]);
} finally { await remove(); }
