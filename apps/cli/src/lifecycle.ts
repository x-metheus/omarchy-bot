import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { layoutFromEnv, serviceFetch, serviceOrigin, type Layout } from "./layout.ts";
import { SWAY_RUNTIME_BUNDLE } from "../../daemon/src/modules/computer/swayRuntimeSupply.ts";
import { FONT_ASSETS, PortableBotComputerAssets } from "../../daemon/src/modules/computer/botComputerAssets.ts";
import { appDiagnostics, graphicalSession, uninstallApp } from "./appInstall.ts";

function unitValue(value: string): string {
  const escaped = value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return /[\s"'\\]/.test(value) ? `"${escaped}"` : escaped;
}

const launcherMarker = "#!/bin/sh\n# Omarchy Bot installed launcher\n";

function ownsLauncher(layout: Layout): boolean {
  try { const stat = lstatSync(layout.launcherPath); return stat.isFile() && stat.uid === process.getuid?.() && readFileSync(layout.launcherPath, "utf8").startsWith(launcherMarker); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function checkLauncher(layout: Layout): void {
  try { lstatSync(layout.launcherPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!ownsLauncher(layout)) throw new Error(`Refusing to replace existing launcher: ${layout.launcherPath}`);
}

export function installLauncher(layout: Layout): void {
  checkLauncher(layout);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  mkdirSync(join(layout.launcherPath, ".."), { recursive: true, mode: 0o755 });
  const temporary = `${layout.launcherPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${launcherMarker}${Object.entries({ HOME: layout.home, OMARCHY_BOT_HOME: layout.dataDir, OMARCHY_BOT_STATE: layout.stateDir, XDG_CONFIG_HOME: layout.env.XDG_CONFIG_HOME || join(layout.home, ".config") }).map(([key, value]) => `export ${key}=\${${key}-${quote(value)}}`).join("\n")}\nexec ${quote(process.execPath)} ${quote(join(layout.currentDir, "apps/cli/src/main.ts"))} "$@"\n`, { mode: 0o755, flag: "wx" });
    renameSync(temporary, layout.launcherPath);
  } finally { rmSync(temporary, { force: true }); }
}

export function renderUnit(layout: Layout): string {
  const environment: NodeJS.ProcessEnv = {
    HOME: layout.home,
    OMARCHY_BOT_HOME: layout.dataDir,
    OMARCHY_BOT_STATE: layout.stateDir,
    OMARCHY_BOT_HOST: layout.host,
    OMARCHY_BOT_PORT: layout.port,
    PATH: [dirname(process.execPath), layout.env.PATH].filter(Boolean).join(":"),
    ...(layout.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: layout.env.XDG_RUNTIME_DIR } : {}),
    ...Object.fromEntries(["OMARCHY_BOT_TLS_CERT", "OMARCHY_BOT_TLS_KEY", "OMARCHY_BOT_TRUSTED_PROXY", "OMARCHY_BOT_BROWSER"].filter(key => layout.env[key]).map(key => [key, layout.env[key]])),
  };
  return [
    "[Unit]",
    "Description=Omarchy Bot",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${unitValue(layout.servePath.replace(/\$/g, "$$$$"))}`,
    `WorkingDirectory=${unitValue(layout.currentDir)}`,
    ...Object.entries(environment).map(([key, value]) => `Environment=${unitValue(`${key}=${value}`)}`),
    "Restart=on-failure",
    "RestartSec=3",
    "KillMode=control-group",
    "NoNewPrivileges=true",
    `StandardOutput=${unitValue(`append:${layout.serviceLog}`)}`,
    `StandardError=${unitValue(`append:${layout.serviceLog}`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function userManagerAvailable(env: NodeJS.ProcessEnv): boolean {
  if (!Bun.which("systemctl", { PATH: env.PATH || "" }) || !env.XDG_RUNTIME_DIR) return false;
  try {
    return statSync(join(env.XDG_RUNTIME_DIR, "systemd/private")).isSocket();
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const executable = Bun.which(command, { PATH: env.PATH || "" });
  if (!executable) throw new Error(`${command} is missing from PATH`);
  const child = Bun.spawn([executable, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function systemctl(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCommand("systemctl", ["--user", ...args], env);
  if (result.exitCode !== 0) throw new Error(result.stderr || `systemctl ${args.join(" ")} failed (${result.exitCode})`);
}

export function checkConfigurationOverrides(layout: Layout): void {
  const directories = [`${layout.unitPath}.d`, ...(layout.env.XDG_RUNTIME_DIR ? [join(layout.env.XDG_RUNTIME_DIR, "systemd/user/omarchy-bot.service.d")] : [])];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter(file => file.endsWith(".conf"))) {
      const source = join(directory, file);
      const settings = readFileSync(source, "utf8").split(/\r?\n/).filter(line => !/^\s*[#;]/.test(line)).join("\n");
      if (/OMARCHY_BOT_(?:HOST|PORT|TLS_CERT|TLS_KEY|TRUSTED_PROXY|BROWSER)\b|^\s*(?:Environment\s*=\s*$|EnvironmentFile\s*=)/m.test(settings)) {
        throw new Error(`Service configuration override conflicts with managed OMARCHY_BOT_ settings: ${source}. Move managed settings to omarchy-bot reconfigure flags/environment and remove those assignments from the drop-in, preserving unrelated settings, then retry.`);
      }
    }
  }
}

export async function installUnit(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  if (!userManagerAvailable(env)) throw new Error("A user systemd manager is required");
  checkConfigurationOverrides(layout);
  mkdirSync(layout.unitDir, { recursive: true, mode: 0o755 });
  writeFileSync(layout.unitPath, renderUnit(layout), { mode: 0o644 });
  chmodSync(layout.unitPath, 0o644);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(layout.stateDir, 0o700);
  closeSync(openSync(layout.serviceLog, "a", 0o600));
  chmodSync(layout.serviceLog, 0o600);
  saveConfiguration(layout);
  await systemctl(["daemon-reload"], env);
  await systemctl(["enable", "--now", "omarchy-bot.service"], env);
}

function saveConfiguration(layout: Layout): void {
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.dataDir, "service.json"), JSON.stringify({ OMARCHY_BOT_HOST: layout.host, OMARCHY_BOT_PORT: layout.port, ...Object.fromEntries(["OMARCHY_BOT_TLS_CERT", "OMARCHY_BOT_TLS_KEY", "OMARCHY_BOT_TRUSTED_PROXY", "OMARCHY_BOT_BROWSER"].map(key => [key, layout.env[key] || ""])) }), { mode: 0o600 });
}

export async function reconfigureUnit(layout: Layout, env: NodeJS.ProcessEnv, healthy: () => Promise<void>): Promise<void> {
  if (!userManagerAvailable(env)) throw new Error("A user systemd manager is required");
  if (!existsSync(layout.unitPath) || !existsSync(layout.servePath)) throw new Error("Service is not installed; run omarchy-bot install first");
  checkConfigurationOverrides(layout);
  const previousUnit = readFileSync(layout.unitPath);
  const configPath = join(layout.dataDir, "service.json");
  const previousConfig = existsSync(configPath) ? readFileSync(configPath) : undefined;
  try {
    writeFileSync(layout.unitPath, renderUnit(layout), { mode: 0o644 });
    saveConfiguration(layout);
    await systemctl(["daemon-reload"], env);
    await systemctl(["restart", "omarchy-bot.service"], env);
    await healthy();
  } catch (error) {
    writeFileSync(layout.unitPath, previousUnit, { mode: 0o644 });
    if (previousConfig) writeFileSync(configPath, previousConfig, { mode: 0o600 });
    else rmSync(configPath, { force: true });
    try {
      await systemctl(["daemon-reload"], env);
      await systemctl(["restart", "omarchy-bot.service"], env);
    } catch (rollback) { throw new Error(`${error instanceof Error ? error.message : String(error)}; restoring previous Service failed: ${rollback instanceof Error ? rollback.message : String(rollback)}`); }
    throw error;
  }
}

export async function startUnit(_layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  await systemctl(["start", "omarchy-bot.service"], env);
}

export async function stopUnit(_layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  await systemctl(["stop", "omarchy-bot.service"], env);
}

export async function statusText(layout: Layout, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand("systemctl", ["--user", "is-active", "omarchy-bot.service"], env);
  const state = result.stdout === "active" || result.stdout === "failed" ? result.stdout : "inactive";
  const lines = [`state: ${state}`, `address: ${serviceOrigin(layout)}`];
  if (state !== "active") {
    let failure = "";
    try {
      failure = readFileSync(layout.serviceLog, "utf8").split(/\r?\n/).filter((line) => line.trim() && line !== "omarchy-bot daemon stopped" && !line.endsWith("disconnected for restart")).at(-1) || "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    lines.push(`startup failure: ${failure || "unavailable"}`);
  }
  return lines.join("\n");
}

export async function doctorText(env: NodeJS.ProcessEnv): Promise<string> {
  const layout = layoutFromEnv(env);
  const lines: string[] = [];
  if (graphicalSession(env)) lines.push(...appDiagnostics(layout));
  const probe = async (command: string, args: string[]) => {
    try {
      const result = await runCommand(command, args, env);
      return result.exitCode === 0 ? result.stdout : "";
    } catch {
      return "";
    }
  };
  const bunVersion = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(await probe("bun", ["--version"]));
  if (!bunVersion || !(Number(bunVersion[1]) > 1 || (Number(bunVersion[1]) === 1 && Number(bunVersion[2]) >= 4))) {
    lines.push("missing: bun >= 1.4");
  }
  for (const command of ["bash", "flock", "systemctl"]) {
    if (!Bun.which(command, { PATH: env.PATH || "" })) lines.push(`missing: ${command}`);
  }
  const [system, architecture] = await Promise.all([probe("uname", ["-s"]), probe("uname", ["-m"])]);
  if (system !== "Linux" || architecture !== "x86_64") lines.push("missing: x86_64 Linux");
  if (!userManagerAvailable(env)) lines.push("missing: user systemd manager socket ($XDG_RUNTIME_DIR/systemd/private)");
  if (!Bun.which("loginctl", { PATH: env.PATH || "" })) {
    lines.push("missing: loginctl");
  } else {
    const result = await runCommand("loginctl", ["show-user", env.USER || "", "-p", "Linger"], env);
    if (result.exitCode === 0 && !result.stdout.includes("Linger=yes")) {
      lines.push(`enable lingering: loginctl enable-linger${env.USER ? ` ${env.USER}` : ""}`);
    }
  }
  const repair = "run omarchy-bot update --archive <path> --checksum <path>";
  const nonempty = (file: string, executable = false) => {
    try { const stat = statSync(file); return stat.isFile() && stat.size > 0 && (!executable || Boolean(stat.mode & 0o111)); } catch { return false; }
  };
  if (!nonempty(layout.servePath, true) || !nonempty(join(layout.currentDir, "apps/daemon/src/bootstrap/main.ts"))) lines.push(`runtime: installed Service is missing or incomplete; ${repair}`);
  let checksum = "";
  try { checksum = readFileSync(join(layout.currentDir, ".archive-sha256"), "utf8").trim(); } catch {}
  if (!/^[a-f0-9]{64}$/.test(checksum)) lines.push(`checksum marker: missing or invalid verified-archive SHA-256; ${repair}`);
  let sway = "";
  try { sway = readFileSync(join(layout.currentDir, "sway/.omarchy-bot-runtime"), "utf8"); } catch {}
  if (sway !== `${SWAY_RUNTIME_BUNDLE.release}\n${SWAY_RUNTIME_BUNDLE.sha256}\n`) lines.push(`Sway bundle: ready marker is missing or mismatched; ${repair}`);
  // shortcut: packaging verifies font checksums; doctor checks availability, rehash if corruption diagnostics are needed.
  const missingFonts = FONT_ASSETS.filter(font => !nonempty(join(layout.currentDir, "fonts", font.file)));
  if (missingFonts.length) lines.push(`fonts: missing or empty ${missingFonts.map(font => font.file).join(", ")}; ${repair}`);
  if (layout.env.OMARCHY_BOT_BROWSER !== "host") {
    try {
      const { browserBin } = await new PortableBotComputerAssets({ profileDir: layout.screensDir, browserPackDir: layout.env.OMARCHY_BOT_BROWSER_PACK_DIR || layout.browserPackDir }).ensureBrowser();
      if (!await probe(browserBin, ["--version"])) throw new Error();
    } catch { lines.push(`browser pack: verified marker or runnable binary is missing or invalid; ${repair} --browser-pack <file-or-https-url>`); }
  }
  const state = await probe("systemctl", ["--user", "is-active", "omarchy-bot.service"]);
  if (!existsSync(layout.unitPath) || state !== "active") lines.push("unit: missing or inactive; run omarchy-bot install --archive <path> --checksum <path>, then omarchy-bot start");
  if (!nonempty(join(layout.home, ".local/bin/omarchy-bot"), true)) lines.push("launcher: missing or not executable; run the installer to restore ~/.local/bin/omarchy-bot");
  try {
    const response = await serviceFetch(layout, "/api/health");
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error();
  } catch { lines.push("health: Service is unreachable or unhealthy; run omarchy-bot status, then omarchy-bot start"); }
  try {
    const secret = readFileSync(layout.hostSecretPath, "utf8").trim();
    const response = await serviceFetch(layout, "/api/devices/paired", { headers: { authorization: `Bearer ${secret}` } });
    if (!response.ok) throw new Error();
    const { devices } = await response.json() as { devices: Array<{ revokedAt?: string | null }> };
    if (!devices.some(device => !device.revokedAt)) lines.push("pairing: no Paired Device; run omarchy-bot pair");
  } catch { lines.push("pairing: cannot read Paired Device state; run omarchy-bot status, then omarchy-bot pair"); }
  if (!lines.some(line => !line.startsWith("enable lingering:"))) lines.push("All required checks passed.");
  return lines.join("\n");
}

export async function uninstall(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  await systemctl(["disable", "--now", "omarchy-bot.service"], env).catch(() => {});
  rmSync(layout.unitPath, { force: true });
  await systemctl(["daemon-reload"], env).catch(() => {});
  rmSync(layout.runtimeDir, { recursive: true, force: true });
  if (ownsLauncher(layout)) rmSync(layout.launcherPath);
  rmSync(join(layout.dataDir, "service.json"), { force: true });
  uninstallApp(layout);
}
