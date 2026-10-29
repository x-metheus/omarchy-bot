import { existsSync } from "node:fs";
import path from "node:path";

const triples: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const override = process.env.OMARCHY_BOT_TEST_SIDECAR_BINARY;
const triple = triples[`${process.platform}-${process.arch}`];
const binary = override ? path.resolve(override) : triple
  ? path.resolve(import.meta.dir, `../../../apps/omarchy-bot/src-tauri/binaries/omarchy-bot-sidecar-${triple}${process.platform === "win32" ? ".exe" : ""}`)
  : undefined;
if (!binary || !existsSync(binary)) {
  throw new Error("Rust Local Sidecar binary missing. Run bun scripts/build-sidecar.ts or set OMARCHY_BOT_TEST_SIDECAR_BINARY to a built Rust Sidecar.");
}
export const sidecarCommand = [binary];
