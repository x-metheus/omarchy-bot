import { createMemoryShell, installShell } from "./lib/shell.ts";

// Only the Vite development server injects this entry; production never loads it.
if (globalThis.__OMARCHY_BOT_SHELL__ === undefined) {
  const baseUrl = import.meta.env.VITE_OMARCHY_AGENT_DAEMON_URL;
  const shell = createMemoryShell(baseUrl ? { fallbackBaseUrl: baseUrl } : {});
  globalThis.__OMARCHY_BOT_MEMORY_SHELL__ = shell;
  installShell(baseUrl ? { ...shell, agentDaemon: {
    baseUrl, autostart: false,
    async ensure() { return (await fetch(`${baseUrl}/health`)).ok; },
  } } : shell);
}
