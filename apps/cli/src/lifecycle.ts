import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";

function unitValue(value: string): string {
  const escaped = value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return /[\s"\\]/.test(value) ? `"${escaped}"` : escaped;
}

export function renderUnit(layout: Layout): string {
  const environment: NodeJS.ProcessEnv = {
    HOME: layout.home,
    OMARCHY_BOT_HOME: layout.dataDir,
    OMARCHY_BOT_STATE: layout.stateDir,
    OMARCHY_BOT_HOST: layout.host,
    OMARCHY_BOT_PORT: layout.port,
    PATH: layout.env.PATH || "",
    ...(layout.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: layout.env.XDG_RUNTIME_DIR } : {}),
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

export async function installUnit(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  if (!userManagerAvailable(env)) throw new Error("A user systemd manager is required");
  mkdirSync(layout.unitDir, { recursive: true, mode: 0o755 });
  writeFileSync(layout.unitPath, renderUnit(layout), { mode: 0o644 });
  chmodSync(layout.unitPath, 0o644);
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(layout.stateDir, 0o700);
  closeSync(openSync(layout.serviceLog, "a", 0o600));
  chmodSync(layout.serviceLog, 0o600);
  await systemctl(["daemon-reload"], env);
  await systemctl(["enable", "--now", "omarchy-bot.service"], env);
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
  const lines = [`state: ${state}`, `address: http://${layout.host}:${layout.port}`];
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
  const lines: string[] = [];
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
  return lines.length ? lines.join("\n") : "All prerequisites available.";
}

export async function uninstall(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  await systemctl(["disable", "--now", "omarchy-bot.service"], env).catch(() => {});
  rmSync(layout.unitPath, { force: true });
  await systemctl(["daemon-reload"], env).catch(() => {});
  rmSync(layout.runtimeDir, { recursive: true, force: true });
}
