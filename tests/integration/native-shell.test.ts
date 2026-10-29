import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Shell } from "../../apps/web/src/lib/shell.ts";

function install(platform: string) {
  const window = new EventTarget();
  const values = new Map<string, string>();
  const context = vm.createContext({
    window: Object.assign(window, {
      fetch: globalThis.fetch,
      __TAURI_INTERNALS__: { async invoke(command: string) {
        if (command === "sidecar_events") return { status: { running: false }, approvals: [] };
        if (command === "take_pairing_request") return null;
        throw new Error(`Unexpected native command: ${command}`);
      } },
    }),
    document: new EventTarget(),
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    queueMicrotask, URL, Request,
  });
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  vm.runInContext(`(${source})(${JSON.stringify({ platform, connection: null })})`, context);
  return context.window.__OMARCHY_BOT_SHELL__ as Shell;
}

test("native shell reports its OS and retains the device key mapping", async () => {
  for (const platform of ["linux", "macos"] as const) {
    const shell = install(platform);
    expect(shell.keyMapping.platform()).toBe(platform);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
    await shell.keyMapping.setMetaSendsSuper(true);
    expect(shell.keyMapping.metaSendsSuper()).toBe(true);
    await shell.keyMapping.setMetaSendsSuper(false);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
  }
});
