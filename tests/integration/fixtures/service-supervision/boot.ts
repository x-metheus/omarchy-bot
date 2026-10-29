/**
 * Boots the real Service in its own process so a fixture user manager can be on
 * PATH from process start (`Bun.which` reads PATH once per process). Used only
 * by the supervision acceptance suite; never talks to the host's systemd.
 */
import path from "node:path";
import { main } from "../../../../apps/daemon/src/bootstrap/main.ts";
import { createFixtureFontSupply } from "../../helpers/fontFixture.ts";

const dataDir = process.env.OMARCHY_BOT_HOME;
const runtimeRoot = process.env.OMARCHY_BOT_SCREEN_RUNTIME_DIR;
if (dataDir === undefined || runtimeRoot === undefined) {
  throw new Error("OMARCHY_BOT_HOME and OMARCHY_BOT_SCREEN_RUNTIME_DIR are required");
}
const { port } = await main({
  useHostApplicationUnits: true,
  botComputerAssetSupply: createFixtureFontSupply(path.join(dataDir, "font-fixture")),
  botScreenRuntimeDir: path.resolve(runtimeRoot),
});
// One write deliberately coalesces a diagnostic and readiness, as startup stdout can.
process.stdout.write(`Service fixture initialized\nSERVICE_READY ${port}\n`);
