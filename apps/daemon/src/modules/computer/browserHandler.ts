import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";

export const BROWSER_HANDLER_SOCKET = "browser.sock";

type BrowserHandler = { close(): void };
const handlers = new Map<string, BrowserHandler>();

/** Private URL dispatch only; Screen authority is selected by the daemon. */
export async function openBrowserHandler(runtimeDir: string, launch: (urls: string[], signal: AbortSignal) => Promise<void>): Promise<BrowserHandler> {
  const lifetime = new AbortController();
  const socketPath = path.join(runtimeDir, BROWSER_HANDLER_SOCKET);
  // A replacement adapter in this daemon supersedes its own prior listener.
  handlers.get(socketPath)?.close();
  if (existsSync(socketPath)) {
    const live = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); reject(new Error("Browser handler socket probe timed out")); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error("Bot Computer browser handler is owned by another daemon");
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
  const server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: 8_192,
    async fetch(request) {
      if (request.method !== "POST") return new Response("POST required", { status: 405 });
      try {
        const urls: unknown = await request.json();
        if (!Array.isArray(urls) || urls.length === 0 || urls.length > 16
          || !urls.every(url => typeof url === "string" && url.length > 0 && !url.startsWith("-"))) {
          return new Response("Expected browser URLs", { status: 400 });
        }
        // Capture authority on receipt, before another request can replace it.
        const work = launch(urls, AbortSignal.any([lifetime.signal, request.signal, AbortSignal.timeout(30_000)]));
        await work;
        return new Response("opened");
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 409 });
      }
    },
  });
  chmodSync(socketPath, 0o600);
  const handler = { close() {
    if (lifetime.signal.aborted) return;
    lifetime.abort(new Error("Bot Computer browser handler closed"));
    void server.stop(true);
    if (handlers.get(socketPath) === handler) handlers.delete(socketPath);
  } };
  handlers.set(socketPath, handler);
  return handler;
}

/** Runs under the same Bun executable as the daemon, with no host PATH lookup. */
export const BROWSER_HANDLER_CLIENT = `
const urls = process.argv.slice(2);
try {
  const response = await fetch("http://localhost/", {
    unix: process.env.XDG_RUNTIME_DIR + "/${BROWSER_HANDLER_SOCKET}",
    method: "POST", body: JSON.stringify(urls.length ? urls : ["about:blank"]),
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(await response.text());
} catch (error) {
  console.error("Bot browser launch failed:", error.message);
  process.exitCode = 1;
}
`;
