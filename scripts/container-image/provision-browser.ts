import { PortableBotComputerAssets, BROWSER_ASSET, BROWSER_LIBRARY_ASSETS } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";

const pins = [BROWSER_ASSET, ...BROWSER_LIBRARY_ASSETS];
const assets = new PortableBotComputerAssets({
  // The ELF interpreter embeds this absolute image path; keep it outside the state volume.
  profileDir: "/opt/omarchy-bot/browser-profile",
  fetch: async (url) => {
    const asset = pins.find((pin) => pin.url === url);
    if (!asset) throw new Error(`unexpected browser download ${url}`);
    return new Response(Bun.file(`/inputs/${asset.sha256}`));
  },
});
const { browserBin } = await assets.ensureBrowser();
const result = Bun.spawnSync([browserBin, "--version"]);
if (result.exitCode !== 0) throw new Error(`browser cannot start: ${result.stderr.toString()}`);
console.log(result.stdout.toString().trim());
