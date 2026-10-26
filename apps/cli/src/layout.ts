import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isLoopbackHost } from "../../daemon/src/bootstrap/listenerConfig.ts";

export interface Layout {
  home: string;
  dataDir: string;
  stateDir: string;
  runtimeDir: string;
  currentDir: string;
  servePath: string;
  unitDir: string;
  unitPath: string;
  launcherPath: string;
  serviceLog: string;
  dbPath: string;
  screensDir: string;
  workspaceDir: string;
  hostSecretPath: string;
  host: string;
  port: string;
  env: NodeJS.ProcessEnv;
}

export function layoutFromEnv(env: NodeJS.ProcessEnv = process.env): Layout {
  const home = resolve(env.HOME || homedir());
  const dataDir = resolve(env.OMARCHY_BOT_HOME || join(home, ".local/share/omarchy-bot"));
  const stateDir = resolve(env.OMARCHY_BOT_STATE || join(home, ".local/state/omarchy-bot"));
  const runtimeDir = join(dataDir, "runtime");
  const currentDir = join(runtimeDir, "current");
  const unitDir = join(resolve(env.XDG_CONFIG_HOME || join(home, ".config")), "systemd/user");
  let saved: NodeJS.ProcessEnv = {};
  try { saved = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  env = { ...saved, ...env };
  env.OMARCHY_BOT_HOST ||= "127.0.0.1";
  env.OMARCHY_BOT_PORT ||= "7321";
  return {
    home,
    dataDir,
    stateDir,
    runtimeDir,
    currentDir,
    servePath: join(currentDir, "scripts/serve.sh"),
    unitDir,
    unitPath: join(unitDir, "omarchy-bot.service"),
    launcherPath: join(home, ".local/bin/omarchy-bot"),
    serviceLog: join(stateDir, "service.log"),
    dbPath: join(dataDir, "db.sqlite"),
    screensDir: join(dataDir, "screens"),
    workspaceDir: join(home, ".omarchy-bot/workspace"),
    hostSecretPath: join(stateDir, "pairing-host-secret"),
    host: env.OMARCHY_BOT_HOST,
    port: env.OMARCHY_BOT_PORT,
    env: { ...env },
  };
}

export function serviceOrigin(layout: Layout): string {
  const host = layout.host.replace(/^\[|\]$/g, "");
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `${layout.env.OMARCHY_BOT_TLS_CERT ? "https" : "http"}://${localHost.includes(":") ? `[${localHost}]` : localHost}:${layout.port}`;
}

export function serviceFetch(layout: Layout, route: string, init: Omit<RequestInit, "body"> & { body?: string } = {}): Promise<Response> {
  const origin = serviceOrigin(layout);
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  const loopback = isLoopbackHost(host);
  const localInterface = !loopback && Object.values(networkInterfaces()).flat().find(address => address?.address === host);
  if (localInterface) {
    // The host secret is accepted only from loopback; retain the destination's TLS identity.
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const request = (origin.startsWith("https:") ? httpsRequest : httpRequest)(`${origin}${route}`, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      localAddress: localInterface.family === "IPv6" ? "::1" : "127.0.0.1",
      signal: init.signal || AbortSignal.timeout(2000),
    }, response => {
      if (response.statusCode! >= 300 && response.statusCode! < 400) { response.resume(); reject(new Error("Service redirects are refused")); return; }
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode!, headers }));
      });
    });
    request.on("error", reject);
    request.end(init.body);
    return promise;
  }
  return fetch(`${origin}${route}`, { ...init, redirect: "error", signal: init.signal || AbortSignal.timeout(2000), ...(origin.startsWith("https:") && loopback ? { tls: { rejectUnauthorized: false } } : {}) });
}
