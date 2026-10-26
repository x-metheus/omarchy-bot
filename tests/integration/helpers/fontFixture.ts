import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PortableBotComputerAssets } from "../../../apps/daemon/src/modules/computer/botComputerAssets.ts";

/** Tiny local bytes exercise font resolution and checksums without a download. */
export function createFixtureFontSupply(directory: string): PortableBotComputerAssets {
  const fontDir = path.join(directory, "fonts");
  mkdirSync(fontDir, { recursive: true });
  const bytes = "fixture font bytes";
  writeFileSync(path.join(fontDir, "Fixture.ttf"), bytes);
  return new PortableBotComputerAssets({
    profileDir: path.join(directory, "profile"),
    fontDir,
    fonts: [{
      name: "fixture-font",
      file: "Fixture.ttf",
      url: "https://assets.invalid/font.ttf",
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    }],
    fetch: async () => { throw new Error("font fixture must not download"); },
  });
}
