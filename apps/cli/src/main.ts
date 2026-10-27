#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertNotRoot, extractRuntimeArchive, verifyChecksum } from "./archive.ts";
import { layoutFromEnv, type Layout } from "./layout.ts";
import { doctorText, installUnit, startUnit, statusText, stopUnit, uninstall, userManagerAvailable } from "./lifecycle.ts";
import { browserPackReleaseUrl, installBrowserPack } from "./browserPack.ts";
import { nativeBrowserCommand } from "../../daemon/src/modules/computer/hostBrowser.ts";
import { PortableBotComputerAssets } from "../../daemon/src/modules/computer/botComputerAssets.ts";

const commands = ["install", "start", "stop", "status", "pair", "devices", "revoke", "update", "uninstall", "doctor"];

async function hostRequest(layout: Layout, route: string, method: string, body?: unknown) {
  const secret = readFileSync(layout.hostSecretPath, "utf8").trim();
  const response = await fetch(`http://${layout.host}:${layout.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Service request ${method} ${route} failed (HTTP ${response.status})`);
  return response;
}

async function pairingUrl(layout: Layout) {
  const response = await hostRequest(layout, "/api/pairing/codes", "POST", { name: "installer" });
  const pairing = await response.json() as { code: string; url: string };
  if (typeof pairing.url !== "string" || !pairing.url.startsWith("/pair?code=")) {
    throw new Error("Service returned an invalid pairing URL");
  }
  return `http://${layout.host}:${layout.port}${pairing.url}`;
}

async function waitForHealth(layout: Layout): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${layout.host}:${layout.port}/api/health`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  let lastLine = "unavailable";
  try { lastLine = readFileSync(layout.serviceLog, "utf8").split(/\r?\n/).filter(line => line.trim()).at(-1) || lastLine; } catch {}
  throw new Error(`Service health check timed out: ${lastLine}`);
}

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { log: (s: string) => void; error: (s: string) => void } = console,
): Promise<number> {
  const [command, ...args] = argv;
  if (!command || !commands.includes(command)) {
    io.error(`Commands: ${commands.join(", ")}`);
    return 2;
  }
  try {
    const layout = layoutFromEnv(env);
    switch (command) {
      case "install":
      case "update": {
        assertNotRoot();
        let archive: string | undefined;
        let checksum: string | undefined;
        let browserPack: string | undefined;
        let withBrowser = false;
        for (let index = 0; index < args.length; index += 1) {
          const flag = args[index];
          if (flag === "--with-browser") { withBrowser = true; continue; }
          const value = args[index + 1];
          if (!["--archive", "--checksum", "--browser-pack"].includes(flag ?? "") || !value || value.startsWith("--")) {
            io.error(`Usage: omarchy-bot ${command} --archive <path> --checksum <path> [--with-browser] [--browser-pack <file-or-https-url>]`);
            return 2;
          }
          if (flag === "--archive") archive = value;
          else if (flag === "--checksum") checksum = value;
          else browserPack = value;
          index += 1;
        }
        if (!archive || !checksum) {
          io.error(`Usage: omarchy-bot ${command} --archive <path> --checksum <path>`);
          return 2;
        }
        const reuse = command === "install" && existsSync(layout.servePath);
        if (reuse) io.log("reusing installed Service");
        else verifyChecksum(archive, checksum);
        if (!userManagerAvailable(env)) throw new Error("A user systemd manager is required ($XDG_RUNTIME_DIR/systemd/private)");
        const environment = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        if (withBrowser || browserPack !== undefined || nativeBrowserCommand(environment) === undefined) {
          const usable = await new PortableBotComputerAssets({ profileDir: layout.screensDir, browserPackDir: layout.browserPackDir }).ensureBrowser().then(() => true, () => false);
          if (!reuse || withBrowser || browserPack !== undefined || !usable) {
            await installBrowserPack(browserPack ?? browserPackReleaseUrl(archive), layout.browserPackDir);
          }
        }
        if (!reuse) {
          const staging = join(layout.runtimeDir, `staging-${process.pid}`);
          rmSync(staging, { recursive: true, force: true });
          try {
            extractRuntimeArchive(archive, staging);
            if (command === "update") {
              await stopUnit(layout, env).catch(error => {
                if (!/not loaded|not found|does not exist/i.test(error.message)) throw error;
              });
              rmSync(layout.currentDir, { recursive: true, force: true });
            }
            renameSync(staging, layout.currentDir);
          } finally {
            rmSync(staging, { recursive: true, force: true });
          }
        }
        if (!existsSync(layout.unitPath)) {
          await installUnit(layout, env);
          if (command === "update") await startUnit(layout, env);
        } else await startUnit(layout, env);
        await waitForHealth(layout);
        const url = await pairingUrl(layout);
        io.log(`pairing: ${url}`);
        try {
          const opener = env.OMARCHY_BOT_OPEN || "xdg-open";
          const executable = Bun.which(opener, { PATH: env.PATH || "" });
          if (!executable) throw new Error("opener is missing from PATH");
          const child = Bun.spawn([executable, url], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          const exitCode = await child.exited;
          if (exitCode !== 0) throw new Error(`opener exited with status ${exitCode}`);
        } catch (error) {
          io.error(`Could not launch opener: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 0;
      }
      case "start":
        await startUnit(layout, env);
        break;
      case "stop":
        await stopUnit(layout, env);
        break;
      case "status":
        io.log(await statusText(layout, env));
        break;
      case "doctor":
        io.log(await doctorText(env));
        break;
      case "pair":
        io.log(`pairing: ${await pairingUrl(layout)}`);
        break;
      case "devices": {
        const response = await hostRequest(layout, "/api/devices/paired", "GET");
        const { devices } = await response.json() as { devices: Array<{ id: string; name: string }> };
        for (const device of devices) io.log(`${device.id}\t${device.name}`);
        break;
      }
      case "revoke":
        if (!args[0]) {
          io.error("Usage: omarchy-bot revoke <id>");
          return 2;
        }
        await hostRequest(layout, `/api/devices/paired/${encodeURIComponent(args[0])}/revoke`, "POST");
        break;
      case "uninstall":
        await uninstall(layout, env);
        break;
    }
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
