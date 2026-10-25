import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BotComputerAssetSupply } from "../../../apps/daemon/src/modules/computer/botComputerAssets.ts";

export interface BrowserLaunch {
  argv: string[];
  fontConfigFile: string | null;
  home: string | null;
  configHome: string | null;
}

export interface FixtureAssetSupply extends BotComputerAssetSupply {
  fontConfigFile: string;
  browserCalls(): number;
  fontCalls(): number;
  browserLaunches(): BrowserLaunch[];
}

/** Offline stand-in for the portable browser and profile fonts. */
export function createFixtureAssetSupply(input: {
  directory: string;
  browserScript: (logPath: string) => string;
}): FixtureAssetSupply {
  mkdirSync(input.directory, { recursive: true });
  const fontConfigFile = path.join(input.directory, "fonts.conf");
  writeFileSync(fontConfigFile, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    "<fontconfig>",
    `  <dir>${path.join(input.directory, "fonts")}</dir>`,
    `  <cachedir>${path.join(input.directory, "cache")}</cachedir>`,
    "</fontconfig>",
    "",
  ].join("\n"));
  const browserBin = path.join(input.directory, "portable-browser");
  const browserLog = path.join(input.directory, "browser.log");
  writeFileSync(browserBin, input.browserScript(browserLog));
  chmodSync(browserBin, 0o700);
  let browserCalls = 0;
  let fontCalls = 0;
  return {
    fontConfigFile,
    async ensureFonts() {
      fontCalls += 1;
      return { fontConfigFile };
    },
    async ensureBrowser() {
      browserCalls += 1;
      return { browserBin };
    },
    browserCalls: () => browserCalls,
    fontCalls: () => fontCalls,
    browserLaunches: () => readFileSync(browserLog, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as BrowserLaunch),
  };
}
