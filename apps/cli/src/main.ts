#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listenerConfig } from "../../daemon/src/bootstrap/listenerConfig.ts";
import { assertNotRoot, extractRuntimeArchive, verifyChecksum } from "./archive.ts";
import { graphicalSession, installApp } from "./appInstall.ts";
import { layoutFromEnv, serviceFetch, serviceOrigin, type Layout } from "./layout.ts";
import { checkConfigurationOverrides, checkLauncher, doctorText, installLauncher, installUnit, reconfigureUnit, startUnit, statusText, stopUnit, uninstall, userManagerAvailable } from "./lifecycle.ts";

const commands = ["install", "start", "stop", "status", "pair", "devices", "revoke", "update", "reconfigure", "uninstall", "doctor"];
const tlsUsage = "[--tls-cert <path> --tls-key <path>] [--trusted-proxy <address>]";
const usage: Record<string, string> = {
  install: `--archive <path> --checksum <path> [--no-browser-pack] [--browser-pack <file-or-https-url>] ${tlsUsage}`,
  update: `--archive <path> --checksum <path> [--no-browser-pack] [--browser-pack <file-or-https-url>] ${tlsUsage}`,
  reconfigure: tlsUsage,
  revoke: "<id>",
};

async function hostRequest(layout: Layout, route: string, method: string, body?: unknown) {
  const secret = readFileSync(layout.hostSecretPath, "utf8").trim();
  const response = await serviceFetch(layout, route, {
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
  let url: URL;
  try { url = new URL(pairing.url); } catch { throw new Error("Service returned an invalid pairing URL"); }
  const address = url.searchParams.get("service");
  if (url.protocol !== "omarchy-bot:" || url.hostname !== "pair" || url.pathname !== "" || typeof pairing.code !== "string" || !pairing.code || url.searchParams.get("code") !== pairing.code || !address) {
    throw new Error("Service returned an invalid pairing URL");
  }
  const origin = new URL(address);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== address) throw new Error("Service returned an invalid pairing URL");
  return { address, code: pairing.code, url: pairing.url };
}

async function waitForHealth(layout: Layout): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await serviceFetch(layout, "/api/health", { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
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
  if (["--help", "-h", "help"].includes(command || "") || (command && commands.includes(command) && args.some(arg => arg === "--help" || arg === "-h"))) {
    io.log(command && commands.includes(command) ? `Usage: omarchy-bot ${command}${usage[command] ? ` ${usage[command]}` : ""}\n` : `Usage: omarchy-bot <command> [options]\nCommands: ${commands.join(", ")}\nUse omarchy-bot <command> --help for command usage.`);
    return 0;
  }
  if (!command || !commands.includes(command)) {
    io.error(`Commands: ${commands.join(", ")}`);
    return 2;
  }
  try {
    let layout = layoutFromEnv(env);
    switch (command) {
      case "install":
      case "update":
      case "reconfigure": {
        assertNotRoot();
        let archive: string | undefined;
        let checksum: string | undefined;
        let browserPack: string | undefined;
        let noBrowserPack = false;
        const configured = { ...layout.env };
        const tlsFlags: Record<string, string> = { "--tls-cert": "OMARCHY_BOT_TLS_CERT", "--tls-key": "OMARCHY_BOT_TLS_KEY", "--trusted-proxy": "OMARCHY_BOT_TRUSTED_PROXY" };
        for (let index = 0; index < args.length; index += 1) {
          const flag = args[index];
          if (flag === "--no-browser-pack" && command !== "reconfigure") { noBrowserPack = true; continue; }
          const value = args[index + 1];
          if ((flag !== "--archive" && flag !== "--checksum" && flag !== "--browser-pack" && !tlsFlags[flag!]) || value === undefined || value.startsWith("--") || (command === "reconfigure" && !tlsFlags[flag!])) {
            io.error(`Usage: omarchy-bot ${command} ${usage[command]}`);
            return 2;
          }
          if (flag === "--archive") archive = value;
          else if (flag === "--checksum") checksum = value;
          else if (flag === "--browser-pack") browserPack = value;
          else configured[tlsFlags[flag!]!] = value;
          index += 1;
        }
        if (noBrowserPack && browserPack !== undefined) {
          io.error("--no-browser-pack cannot be combined with --browser-pack");
          return 2;
        }
        if (configured.OMARCHY_BOT_BROWSER && configured.OMARCHY_BOT_BROWSER !== "host") {
          io.error("OMARCHY_BOT_BROWSER must be host or empty to use the browser pack");
          return 2;
        }
        if (Boolean(configured.OMARCHY_BOT_TLS_CERT) !== Boolean(configured.OMARCHY_BOT_TLS_KEY)) {
          io.error("--tls-cert and --tls-key must both be set (or both empty to disable TLS)");
          return 2;
        }
        for (const key of ["OMARCHY_BOT_TLS_CERT", "OMARCHY_BOT_TLS_KEY"]) {
          if (!configured[key]) continue;
          configured[key] = resolve(configured[key]);
          try { if (!(await Bun.file(configured[key]).exists())) throw new Error(); readFileSync(configured[key]); }
          catch { io.error(`TLS file is missing or unreadable: ${configured[key]}`); return 2; }
        }
        try {
          const listener = listenerConfig(configured);
          const probe = Bun.serve({ hostname: listener.host.replace(/^\[|\]$/g, ""), port: 0, ...(listener.tlsCert && listener.tlsKey ? { tls: { cert: Bun.file(listener.tlsCert), key: Bun.file(listener.tlsKey) } } : {}), fetch: () => new Response(null, { status: 503 }) });
          await probe.stop(true);
        } catch (error) { io.error(`Listener/TLS configuration is invalid: ${error instanceof Error ? error.message : String(error)}`); return 2; }
        layout = layoutFromEnv(configured);
        checkConfigurationOverrides(layout);
        if (command === "reconfigure") {
          await reconfigureUnit(layout, env, () => waitForHealth(layout));
          io.log("Service reconfigured.");
          return 0;
        }
        if (!archive || !checksum) {
          io.error(`Usage: omarchy-bot ${command} --archive <path> --checksum <path>`);
          return 2;
        }
        const reuse = command === "install" && existsSync(layout.servePath);
        if (reuse) io.log("reusing installed Service");
        const archiveChecksum = reuse ? undefined : verifyChecksum(archive, checksum);
        if (!userManagerAvailable(env)) throw new Error("A user systemd manager is required ($XDG_RUNTIME_DIR/systemd/private)");
        checkLauncher(layout);
        const staging = join(layout.runtimeDir, `staging-${process.pid}`);
        const stagedBrowser = join(layout.runtimeDir, `browser-staging-${process.pid}`);
        const previousRuntime = join(layout.runtimeDir, `previous-${process.pid}`);
        const previousBrowser = join(layout.runtimeDir, `browser-previous-${process.pid}`);
        let runtimeChanged = false;
        let browserChanged = false;
        let stopped = false;
        try {
          if (!reuse) {
            extractRuntimeArchive(archive, staging);
            if (!statSync(join(staging, "scripts/serve.sh")).isFile()) throw new Error("runtime archive has no Service entrypoint");
            writeFileSync(join(staging, ".archive-sha256"), `${archiveChecksum}\n`, { mode: 0o644 });
            writeFileSync(join(staging, ".runtime-archive"), `${basename(archive)}\n`, { mode: 0o644 });
          }
          if (!noBrowserPack) {
            const target = reuse ? layout.currentDir : staging;
            // Only the verified target archive (or retained runtime) knows its browser modules and pins.
            const { PortableBotComputerAssets } = await import(pathToFileURL(join(target, "apps/daemon/src/modules/computer/botComputerAssets.ts")).href);
            const { browserPackReleaseUrl, installBrowserPack } = await import(pathToFileURL(join(target, "apps/cli/src/browserPack.ts")).href);
            const { prepareBrowserPack } = await import(pathToFileURL(join(target, "apps/daemon/src/modules/computer/browserPack.ts")).href);
            const usable = await new PortableBotComputerAssets({ profileDir: layout.screensDir, browserPackDir: layout.browserPackDir }).ensureBrowser().then(async ({ browserBin }: { browserBin: string }) => {
              try {
                const child = Bun.spawn([browserBin, "--version"], { env: layout.env, stdout: "ignore", stderr: "ignore" });
                return await child.exited === 0;
              } catch { return false; }
            }, () => false);
            if (!usable) {
              const runtimeArchive = reuse && !browserPack ? readFileSync(join(target, ".runtime-archive"), "utf8").trim() : archive;
              await installBrowserPack(browserPack ?? browserPackReleaseUrl(runtimeArchive), stagedBrowser);
              // Retained installers only know the staging path; relocate before publication.
              prepareBrowserPack(stagedBrowser, layout.browserPackDir);
            }
          }
          if (!reuse && command === "update") {
            await stopUnit(layout, env).catch(error => {
              if (!/not loaded|not found|does not exist/i.test(error.message)) throw error;
            });
            stopped = true;
          }
          if (existsSync(stagedBrowser)) {
            if (existsSync(layout.browserPackDir)) renameSync(layout.browserPackDir, previousBrowser);
            browserChanged = true;
            renameSync(stagedBrowser, layout.browserPackDir);
          }
          if (!reuse) {
            if (existsSync(layout.currentDir)) renameSync(layout.currentDir, previousRuntime);
            runtimeChanged = true;
            renameSync(staging, layout.currentDir);
          }
        } catch (error) {
          if (runtimeChanged) {
            rmSync(layout.currentDir, { recursive: true, force: true });
            if (existsSync(previousRuntime)) renameSync(previousRuntime, layout.currentDir);
          }
          if (browserChanged) {
            rmSync(layout.browserPackDir, { recursive: true, force: true });
            if (existsSync(previousBrowser)) renameSync(previousBrowser, layout.browserPackDir);
          }
          if (stopped) await startUnit(layout, env);
          throw error;
        } finally {
          for (const directory of [staging, stagedBrowser]) rmSync(directory, { recursive: true, force: true });
          if (existsSync(layout.runtimeDir) && !existsSync(layout.currentDir) && !existsSync(layout.browserPackDir)) {
            try { rmdirSync(layout.runtimeDir); } catch {}
          }
        }
        for (const directory of [previousRuntime, previousBrowser]) rmSync(directory, { recursive: true, force: true });
        installLauncher(layout);
        if (!existsSync(layout.unitPath)) {
          await installUnit(layout, env);
          if (command === "update") await startUnit(layout, env);
        } else if (env.OMARCHY_BOT_BROWSER !== undefined || Object.values(tlsFlags).some(key => env[key] !== undefined) || args.some(arg => Boolean(tlsFlags[arg]))) await reconfigureUnit(layout, env, () => waitForHealth(layout));
        else await startUnit(layout, env);
        await waitForHealth(layout);
        let appFailure: unknown;
        if (command === "install" && graphicalSession(env)) {
          try { await installApp(layout, env); } catch (error) { appFailure = error; }
        }
        const pairing = await pairingUrl(layout).catch(error => {
          if (appFailure) throw new Error(`${appFailure instanceof Error ? appFailure.message : String(appFailure)}; could not issue pairing: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        });
        const { url } = pairing;
        io.log(`address: ${pairing.address}\ncode: ${pairing.code}\npairing: ${url}`);
        if (appFailure) throw appFailure;
        if (graphicalSession(env)) try {
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
      case "doctor": {
        const diagnosis = await doctorText(env);
        io.log(diagnosis);
        return diagnosis.includes("All required checks passed.") ? 0 : 1;
      }
      case "pair": {
        const pairing = await pairingUrl(layout);
        io.log(`address: ${pairing.address}\ncode: ${pairing.code}\npairing: ${pairing.url}`);
        break;
      }
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
