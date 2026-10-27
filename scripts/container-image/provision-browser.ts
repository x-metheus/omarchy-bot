import { readdirSync } from "node:fs";
import { installBrowserPack } from "../../apps/cli/src/browserPack.ts";

const pack = readdirSync("/inputs").find(file => file.endsWith(".tar.zst"));
if (!pack) throw new Error("image inputs have no browser pack");
await installBrowserPack(`/inputs/${pack}`, "/opt/omarchy-bot/browser");
const result = Bun.spawnSync(["/opt/omarchy-bot/browser/browser", "--version"]);
if (result.exitCode !== 0) throw new Error(`browser cannot start: ${result.stderr.toString()}`);
console.log(result.stdout.toString().trim());
