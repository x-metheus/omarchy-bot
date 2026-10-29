import { createMemoryShell, installShell } from "./lib/shell.ts";

// Only the Vite development server injects this entry; production never loads it.
if (globalThis.__OMARCHY_BOT_SHELL__ === undefined) {
  const shell = createMemoryShell();
  globalThis.__OMARCHY_BOT_MEMORY_SHELL__ = shell;
  installShell(shell);
}
