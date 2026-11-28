import assert from "node:assert/strict";
import { copyFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const version = process.env.APP_VERSION || "0.1.0";
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || ".lane/agent-daemon/target");
const dist = path.join(root, ".lane/dist");
const binaries = path.join(root, "apps/omarchy-bot/src-tauri/binaries");
const name = `omarchy-agent-daemon${process.platform === "win32" ? ".exe" : ""}`;
const executable = path.join(target, "release", name);
const env = { ...process.env, CARGO_TARGET_DIR: target };

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  assert.equal(await child.exited, 0, `${command[0]} failed (${command[1]})`);
}

const rustc = Bun.spawnSync(["rustc", "--print", "host-tuple"], { cwd: root, env });
assert.equal(rustc.exitCode, 0, rustc.stderr.toString());
const triple = rustc.stdout.toString().trim();
assert.ok(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"].includes(triple), `Unsupported native release target ${triple}`);

await run(["cargo", "build", "--release", "--locked", "-j", "3", "-p", "omarchy-agent-daemon"]);
await Promise.all([mkdir(binaries, { recursive: true }), mkdir(dist, { recursive: true })]);
await run([executable, "--prepare-recall-model", path.join(binaries, "recall-model")]);
await copyFile(path.join(root, "apps/agent-daemon/recall-model.LICENSE"), path.join(binaries, "recall-model", "LICENSE"));
await copyFile(executable, path.join(binaries, name.replace(/^omarchy-agent-daemon/, `omarchy-agent-daemon-${triple}`)));

const archive = `omarchy-agent-daemon_${version}_${triple}.tar.gz`;
const output = path.join(dist, archive);
await run(["tar", "-czf", `${output}.partial`, "-C", path.dirname(executable), name, "-C", binaries, "recall-model"]);
const sha256 = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(`${output}.partial`).stream()) sha256.update(chunk);
await rename(`${output}.partial`, output);
await Bun.write(`${output}.sha256`, `${sha256.digest("hex")}  ${archive}\n`);
console.log(`Verified and packaged ${archive}`);
