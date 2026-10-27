import { installBrowserPack } from "../apps/cli/src/browserPack.ts";
const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw new Error("Usage: bun scripts/install-browser-pack.ts <archive> <destination>");
await installBrowserPack(archive, destination);
