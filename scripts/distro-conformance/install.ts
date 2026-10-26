import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractRuntimeArchive, verifyChecksum } from "../../apps/cli/src/archive.ts";

const [archive, destination] = process.argv.slice(2);
assert(archive && destination, "Usage: install.ts <runtime.tar.zst> <destination>");
assert(process.getuid!() !== 0, "run the container installation as an ordinary user");
verifyChecksum(archive, `${archive}.sha256`);
extractRuntimeArchive(archive, destination);
assert(readFileSync(path.join(destination, "sway/.omarchy-bot-runtime"), "utf8").length > 64);
mkdirSync(path.join(process.env.OMARCHY_BOT_HOME!, "conformance"), { recursive: true });
await Bun.write(path.join(process.env.OMARCHY_BOT_HOME!, "conformance/pi-fake-pi-1.json"), JSON.stringify({ ok: true, image: "verified" }));
