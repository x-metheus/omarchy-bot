import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractRuntimeArchive, verifyChecksum } from "../../apps/cli/src/archive.ts";
import { installBrowserPack } from "../../apps/cli/src/browserPack.ts";

const [archive, destination, browserPack] = process.argv.slice(2);
assert(archive && destination && browserPack, "Usage: install.ts <runtime.tar.zst> <destination> <browser-pack.tar.zst>");
assert(process.getuid!() !== 0, "run the container installation as an ordinary user");
verifyChecksum(archive, `${archive}.sha256`);
extractRuntimeArchive(archive, destination);
assert(readFileSync(path.join(destination, "sway/.omarchy-bot-runtime"), "utf8").length > 64);
await installBrowserPack(browserPack, path.join(process.env.OMARCHY_BOT_HOME!, "runtime", "browser"));
mkdirSync(path.join(process.env.OMARCHY_BOT_HOME!, "conformance"), { recursive: true });
await Bun.write(path.join(process.env.OMARCHY_BOT_HOME!, "conformance/pi-fake-pi-1.json"), JSON.stringify({ ok: true, image: "verified" }));
