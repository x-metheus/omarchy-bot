import { lstatSync } from "node:fs";
import path from "node:path";
import type { SurfaceId } from "@omarchy-bot/domain";
export type ApplicationUnitRole =
  | "compositor"
  | "application"
  | "input"
  | "capture"
  | `capture-${string}`
  | "wayvnc";

export type BotComputerUnitRole =
  | "compositor"
  | "session-bus"
  | `application-${string}`;


function socketExists(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSocket();
  } catch {
    return false;
  }
}

async function run(argv: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}
export function applicationUnitName(
  surfaceId: SurfaceId,
  generation: number,
  role: ApplicationUnitRole,
): string {
  return `omarchy-bot-screen-${surfaceId.slice("surf_".length)}-g${generation}-${role}.service`;
}

export function botComputerUnitName(
  generation: number,
  role: BotComputerUnitRole,
): string {
  return `omarchy-bot-computer-g${generation}-${role}.service`;
}

/**
 * Places every production Bot Screen child in a Surface-owned transient user
 * service when a user systemd manager is available. The service executes
 * through `env -i`, so only the target environment supplied here reaches the
 * child and the daemon never imports values into the global user manager.
 */
export class ApplicationUnits {
  readonly enabled: boolean;
  #systemdRun: string | undefined;
  #systemctl: string | undefined;
  #env: string | undefined;

  constructor(private readonly hostRuntimeDir?: string) {
    this.#systemdRun = Bun.which("systemd-run") ?? undefined;
    this.#systemctl = Bun.which("systemctl") ?? undefined;
    this.#env = Bun.which("env") ?? undefined;
    this.enabled = this.#systemdRun !== undefined
      && this.#systemctl !== undefined
      && this.#env !== undefined
      && hostRuntimeDir !== undefined
      && socketExists(path.join(hostRuntimeDir, "systemd", "private"));
  }

  command(
    surfaceId: SurfaceId,
    generation: number,
    role: ApplicationUnitRole,
    targetEnvironment: Record<string, string>,
  ): string[] {
    return this.#command(applicationUnitName(surfaceId, generation, role), targetEnvironment);
  }

  computerCommand(
    generation: number,
    role: BotComputerUnitRole,
    targetEnvironment: Record<string, string>,
    workingDirectory?: string,
  ): string[] {
    return this.#command(
      botComputerUnitName(generation, role),
      targetEnvironment,
      workingDirectory,
    );
  }

  launcherEnvironment(targetEnvironment: Record<string, string>): Record<string, string> {
    if (!this.enabled) return targetEnvironment;
    const hostRuntimeDir = this.hostRuntimeDir;
    if (hostRuntimeDir === undefined) {
      throw new Error("Bot Screen application units are enabled without a host runtime directory");
    }
    const environment: Record<string, string> = {
      HOME: process.env.HOME ?? targetEnvironment.HOME ?? "",
      LANG: process.env.LANG ?? targetEnvironment.LANG ?? "C.UTF-8",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      USER: process.env.USER ?? targetEnvironment.USER ?? "",
      LOGNAME: process.env.LOGNAME ?? targetEnvironment.LOGNAME ?? "",
      XDG_RUNTIME_DIR: hostRuntimeDir,
    };
    if (process.env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
      environment.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
    }
    return environment;
  }

  async stop(surfaceId: SurfaceId, generation?: number): Promise<void> {
    const prefix = this.#prefix(surfaceId);
    const pattern = generation === undefined ? `${prefix}-g*` : `${prefix}-g${generation}-*`;
    await this.#stopPattern(`${pattern}.service`, "Bot Screen");
  }

  async stopRole(
    surfaceId: SurfaceId,
    generation: number,
    role: ApplicationUnitRole,
  ): Promise<void> {
    await this.#stopPattern(applicationUnitName(surfaceId, generation, role), "Bot Screen");
  }

  async stopComputer(generation?: number): Promise<void> {
    const pattern = generation === undefined
      ? "omarchy-bot-computer-g*-*.service"
      : `omarchy-bot-computer-g${generation}-*.service`;
    await this.#stopPattern(pattern, "Bot Computer");
  }

  #command(
    unitName: string,
    targetEnvironment: Record<string, string>,
    workingDirectory?: string,
  ): string[] {
    if (!this.enabled) return [];
    const systemdRun = this.#systemdRun;
    const env = this.#env;
    if (systemdRun === undefined || env === undefined) {
      throw new Error("Bot application units are enabled without their required executables");
    }
    const explicitEnvironment = Object.entries(targetEnvironment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`);
    return [
      systemdRun,
      "--user",
      "--quiet",
      "--collect",
      "--wait",
      "--pipe",
      "--service-type=exec",
      `--unit=${unitName.slice(0, -".service".length)}`,
      "--slice=app.slice",
      "--property=KillMode=control-group",
      ...(workingDirectory === undefined ? [] : [`--working-directory=${workingDirectory}`]),
      "--",
      env,
      "-i",
      ...explicitEnvironment,
    ];
  }

  async #stopPattern(unitPattern: string, owner: string): Promise<void> {
    if (!this.enabled) return;
    const systemctl = this.#systemctl;
    if (systemctl === undefined) {
      throw new Error("Bot application units are enabled without systemctl");
    }
    const stopped = await run([systemctl, "--user", "stop", unitPattern]);
    if (stopped.status === 0) return;
    const remaining = await run([
      systemctl,
      "--user",
      "list-units",
      "--all",
      "--full",
      "--plain",
      "--no-legend",
      unitPattern,
    ]);
    const hasRemainingUnits = remaining.stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/, 1)[0]?.endsWith(".service") === true);
    if (remaining.status === 0 && !hasRemainingUnits) return;
    throw new Error(`could not stop ${owner} application units: ${stopped.stderr.trim() || `status ${stopped.status}`}`);
  }

  #prefix(surfaceId: SurfaceId): string {
    return `omarchy-bot-screen-${surfaceId.slice("surf_".length)}`;
  }
}
