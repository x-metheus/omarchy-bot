import { afterEach, expect, test } from "bun:test";
import { createMemoryShell, getShell, installShell } from "./shell.ts";
import { withDeviceToken } from "./urls.ts";

const originalShell = getShell();
afterEach(() => installShell(originalShell));

test("browser-loaded paths resolve against the paired Service and retain query and fragment", async () => {
  const shell = createMemoryShell({ storage: null });
  installShell(shell);
  await shell.service.store("https://service.example", "paired-token");
  expect(withDeviceToken("/api/attachments/one?download=1#preview")).toBe("https://service.example/api/attachments/one?download=1&access_token=paired-token#preview");
  await shell.service.clear();
  expect(withDeviceToken("/api/bots/one/avatar")).toBe("http://127.0.0.1:7321/api/bots/one/avatar");
});
