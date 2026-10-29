import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const triple = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
}[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`Unsupported Sidecar build host: ${process.platform}-${process.arch}`);
const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "apps/omarchy-bot/src-tauri/binaries");
mkdirSync(directory, { recursive: true });
const output = path.join(directory, `omarchy-bot-sidecar-${triple}${process.platform === "win32" ? ".exe" : ""}`);
const cargoHome = process.env.CARGO_HOME || path.join(root, ".lane/sidecar-rust/cargo");
const targetDirectory = process.env.CARGO_TARGET_DIR || path.join(root, ".lane/sidecar-rust/target");
const child = Bun.spawn(["cargo", "build", "--release", "--locked", "--manifest-path", "apps/sidecar-rust/Cargo.toml"], {
  cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: targetDirectory },
});
if (await child.exited !== 0) throw new Error("Bundled Rust Sidecar compilation failed");
const source = path.resolve(root, targetDirectory, "release", `omarchy-bot-sidecar${process.platform === "win32" ? ".exe" : ""}`);
copyFileSync(source, output);
console.log(`Bundled Rust Sidecar: ${source} -> ${output} (${statSync(output).size} bytes)`);
