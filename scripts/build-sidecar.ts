import { mkdirSync } from "node:fs";
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
const child = Bun.spawn([process.execPath, "build", "--compile", path.join(root, "apps/sidecar/src/main.ts"), "--outfile", output], {
  cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
if (await child.exited !== 0) throw new Error("Bundled Sidecar compilation failed");
console.log(`Compiled bundled Sidecar: ${output}`);
