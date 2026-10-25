import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SurfaceId } from "../../../packages/domain/src/ids.ts";
import { authedFetch, type Harness } from "./harness.ts";

export const SCREEN_PROCESS_ROLES = ["compositor", "application", "input", "worker", "capture", "wayvnc"] as const;
export type ScreenProcessRole = typeof SCREEN_PROCESS_ROLES[number];

export interface ScreenOwner {
  botId: string;
  surfaceId: SurfaceId;
}

export interface ScreenProcessSample {
  pid: number;
  role: ScreenProcessRole | "unknown";
  executable: string;
  pssMiB: number;
  rssMiB: number;
  cpuPercent: number;
}

export interface ScreenResources {
  surfaceId: SurfaceId;
  pids: number[];
  pssMiB: number;
  rssMiB: number;
  cpuPercent: number;
  gpu: {
    attributable: false;
    utilizationPercent: null;
    vramMiB: null;
  };
  processes: ScreenProcessSample[];
}

export interface ResourceWindow {
  durationMs: number;
  screens: ScreenResources[];
  daemonAndHarness: {
    pssMiB: number;
    rssMiB: number;
    cpuPercent: number;
    note: "daemon and test harness share this process; combined measurement, not a split";
  };
  total: {
    pssMiB: number;
    rssMiB: number;
    cpuPercent: number;
  };
}

export interface RoleAttribution {
  method: "systemd-unit" | "executable-fallback" | "mixed" | "none";
  pluginInfrastructure: { pssMiB: number; rssMiB: number; cpuPercent: number; processes: number };
  agentApplication: { pssMiB: number; rssMiB: number; cpuPercent: number; processes: number };
  unknown: { pssMiB: number; rssMiB: number; cpuPercent: number; processes: number };
  daemonAndHarness: ResourceWindow["daemonAndHarness"];
  wholeScenario: ResourceWindow["total"];
}

export interface HostSessionObservation {
  observedAt: string;
  method: "systemctl --user show-environment / list-units / is-active";
  userManagerEnvironment: {
    available: boolean;
    WAYLAND_DISPLAY: string | null;
    XDG_RUNTIME_DIR: string | null;
    XDG_CURRENT_DESKTOP: string | null;
    DISPLAY: string | null;
    botDisplayLeak: string[];
    rawStatus: number;
  };
  graphicalSession: {
    units: Array<{ unit: string; active: string | null }>;
  };
  leftoverScreenUnits: string[];
  visibleScreenUnits: string[];
  cannotProve: string[];
}

export interface SupervisionLabel {
  path: "production-style-application-units" | "harness-mode-direct-children";
  useHostApplicationUnits: boolean;
  note: string;
}

const PLUGIN_ROLES = new Set<ScreenProcessRole>(["compositor", "input", "capture", "wayvnc"]);
const APPLICATION_ROLES = new Set<ScreenProcessRole>(["application", "worker"]);

export async function command(argv: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function unitName(surfaceId: SurfaceId, generation: number, role: string): string {
  return `omarchy-bot-screen-${surfaceId.slice("surf_".length)}-g${generation}-${role}.service`;
}

export async function roleUnitNames(
  owner: ScreenOwner,
  generation: number,
  role: ScreenProcessRole,
): Promise<string[]> {
  const pattern = unitName(owner.surfaceId, generation, `${role}*`);
  const result = await command([
    "systemctl",
    "--user",
    "list-units",
    "--all",
    "--full",
    "--plain",
    "--no-legend",
    pattern,
  ]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((unit): unit is string => unit !== undefined && unit.endsWith(".service"));
}

export async function screenPidRoles(
  owner: ScreenOwner,
  generation: number,
): Promise<Map<number, ScreenProcessRole | "unknown">> {
  const pids = new Map<number, ScreenProcessRole | "unknown">();
  if (Bun.which("systemctl") !== null) {
    for (const role of SCREEN_PROCESS_ROLES) {
      for (const unit of await roleUnitNames(owner, generation, role)) {
        const result = await command(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--value"]);
        const file = result.status === 0 && result.stdout !== ""
          ? path.join("/sys/fs/cgroup", result.stdout, "cgroup.procs")
          : "";
        if (file !== "" && existsSync(file)) {
          for (const raw of readFileSync(file, "utf8").trim().split(/\s+/)) {
            const pid = Number(raw);
            if (Number.isSafeInteger(pid) && pid > 0) pids.set(pid, role);
          }
        }
      }
    }
  }
  if (pids.size > 0) return pids;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (cmdline.includes(owner.surfaceId) || environment.includes(owner.surfaceId)) {
        pids.set(Number(entry), "unknown");
      }
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  return pids;
}

export function processSample(pid: number): { ticks: number; pssKiB: number; rssKiB: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const pssKiB = Number(/^Pss:\s+(\d+) kB$/m.exec(rollup)?.[1] ?? 0);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKiB = Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0);
    return { ticks, pssKiB, rssKiB };
  } catch {
    return undefined;
  }
}

export async function resourceWindow(
  owners: ScreenOwner[],
  generationBySurface: Map<SurfaceId, number>,
  durationMs: number,
  activity?: (deadlineMs: number) => Promise<void>,
): Promise<ResourceWindow> {
  const hertzResult = await command(["getconf", "CLK_TCK"]);
  const hertz = Number(hertzResult.stdout) || 100;
  const before = new Map<number, number>();
  const beforePids = new Map<SurfaceId, Map<number, ScreenProcessRole | "unknown">>();
  const daemonBefore = processSample(process.pid);
  for (const owner of owners) {
    const pids = await screenPidRoles(owner, generationBySurface.get(owner.surfaceId) ?? 1);
    beforePids.set(owner.surfaceId, pids);
    for (const pid of pids.keys()) {
      const sample = processSample(pid);
      if (sample !== undefined) before.set(pid, sample.ticks);
    }
  }
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  if (activity === undefined) await Bun.sleep(durationMs);
  else await activity(deadline);
  const elapsedMs = performance.now() - startedAt;
  const daemonAfter = processSample(process.pid);
  const daemonAndHarness = {
    pssMiB: Number(((daemonAfter?.pssKiB ?? 0) / 1024).toFixed(2)),
    rssMiB: Number(((daemonAfter?.rssKiB ?? 0) / 1024).toFixed(2)),
    cpuPercent: Number((
      ((daemonAfter?.ticks ?? 0) - (daemonBefore?.ticks ?? 0))
      / hertz
      / (elapsedMs / 1_000)
      * 100
    ).toFixed(2)),
    note: "daemon and test harness share this process; combined measurement, not a split" as const,
  };
  const screens: ScreenResources[] = [];
  for (const owner of owners) {
    const pidRoles = new Map(beforePids.get(owner.surfaceId) ?? []);
    for (const [pid, role] of await screenPidRoles(owner, generationBySurface.get(owner.surfaceId) ?? 1)) {
      pidRoles.set(pid, role);
    }
    const processes: ScreenProcessSample[] = [];
    for (const [pid, role] of pidRoles) {
      const sample = processSample(pid);
      if (sample === undefined) continue;
      const firstTicks = before.get(pid);
      const ticks = firstTicks === undefined ? 0 : Math.max(0, sample.ticks - firstTicks);
      let executable = "unknown";
      try {
        executable = path.basename(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "") || "unknown";
      } catch {
        // Process identity is best-effort diagnostic data.
      }
      processes.push({
        pid,
        role,
        executable,
        pssMiB: Number((sample.pssKiB / 1024).toFixed(2)),
        rssMiB: Number((sample.rssKiB / 1024).toFixed(2)),
        cpuPercent: Number(((ticks / hertz) / (elapsedMs / 1000) * 100).toFixed(2)),
      });
    }
    processes.sort((left, right) => left.pid - right.pid);
    screens.push({
      surfaceId: owner.surfaceId,
      pids: processes.map((entry) => entry.pid),
      pssMiB: Number(processes.reduce((sum, entry) => sum + entry.pssMiB, 0).toFixed(2)),
      rssMiB: Number(processes.reduce((sum, entry) => sum + entry.rssMiB, 0).toFixed(2)),
      cpuPercent: Number(processes.reduce((sum, entry) => sum + entry.cpuPercent, 0).toFixed(2)),
      gpu: { attributable: false, utilizationPercent: null, vramMiB: null },
      processes,
    });
  }
  return {
    durationMs: Number(elapsedMs.toFixed(2)),
    screens,
    daemonAndHarness,
    total: {
      pssMiB: Number((screens.reduce((sum, screen) => sum + screen.pssMiB, 0) + daemonAndHarness.pssMiB).toFixed(2)),
      rssMiB: Number((screens.reduce((sum, screen) => sum + screen.rssMiB, 0) + daemonAndHarness.rssMiB).toFixed(2)),
      cpuPercent: Number((
        screens.reduce((sum, screen) => sum + screen.cpuPercent, 0) + daemonAndHarness.cpuPercent
      ).toFixed(2)),
    },
  };
}

export function matchingProcessPids(executableName: string): Set<number> {
  const pids = new Set<number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const directDaemonChild = Number(fields[1]) === process.pid;
      const cgroup = readFileSync(`/proc/${entry}/cgroup`, "utf8");
      const surfaceUnitChild = cgroup.includes("omarchy-bot-screen-");
      if (!directDaemonChild && !surfaceUnitChild) continue;
      if (path.basename(commandLine[0] ?? "") === executableName) {
        pids.add(Number(entry));
      }
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  return pids;
}

export function activeWayvncCount(): number {
  return matchingProcessPids("wayvnc").size;
}

export function surfaceScopedProcessCount(surfaceId: SurfaceId, executables?: readonly string[]): number {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (!cmdline.includes(surfaceId) && !environment.includes(surfaceId)) continue;
      if (executables !== undefined) {
        const executable = path.basename(cmdline.split("\0")[0] ?? "");
        if (!executables.includes(executable)) continue;
      }
      count += 1;
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  return count;
}

export function daemonGitChildCount(): number {
  let count = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) !== process.pid) continue;
      const executable = path.basename(readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")[0] ?? "");
      if (executable === "git") count += 1;
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  return count;
}

function classifyExecutable(executable: string): "pluginInfrastructure" | "agentApplication" | "unknown" {
  const name = executable.toLowerCase();
  if (
    name === "sway"
    || name === "wayvnc"
    || name.includes("wayland-capture")
    || name.includes("wayland-input")
    || name.includes("wlr-randr")
    || name.includes("bot-desktop")
  ) return "pluginInfrastructure";
  if (
    name.includes("chrom")
    || name.includes("brave")
    || name.includes("firefox")
    || name.includes("bot-screen-browser")
  ) return "agentApplication";
  return "unknown";
}

function emptyBucket(): RoleAttribution["pluginInfrastructure"] {
  return { pssMiB: 0, rssMiB: 0, cpuPercent: 0, processes: 0 };
}

function addToBucket(
  bucket: RoleAttribution["pluginInfrastructure"],
  process: ScreenProcessSample,
): void {
  bucket.pssMiB = Number((bucket.pssMiB + process.pssMiB).toFixed(2));
  bucket.rssMiB = Number((bucket.rssMiB + process.rssMiB).toFixed(2));
  bucket.cpuPercent = Number((bucket.cpuPercent + process.cpuPercent).toFixed(2));
  bucket.processes += 1;
}

export function attributeResourceWindow(window: ResourceWindow): RoleAttribution {
  const pluginInfrastructure = emptyBucket();
  const agentApplication = emptyBucket();
  const unknown = emptyBucket();
  let sawUnit = false;
  let sawFallback = false;
  for (const screen of window.screens) {
    for (const process of screen.processes) {
      if (process.role !== "unknown") sawUnit = true;
      else sawFallback = true;
      if (process.role !== "unknown" && PLUGIN_ROLES.has(process.role)) {
        addToBucket(pluginInfrastructure, process);
        continue;
      }
      if (process.role !== "unknown" && APPLICATION_ROLES.has(process.role)) {
        addToBucket(agentApplication, process);
        continue;
      }
      const classified = classifyExecutable(process.executable);
      if (classified === "pluginInfrastructure") addToBucket(pluginInfrastructure, process);
      else if (classified === "agentApplication") addToBucket(agentApplication, process);
      else addToBucket(unknown, process);
    }
  }
  return {
    method: window.screens.every((screen) => screen.processes.length === 0)
      ? "none"
      : sawUnit && sawFallback
      ? "mixed"
      : sawUnit
      ? "systemd-unit"
      : "executable-fallback",
    pluginInfrastructure,
    agentApplication,
    unknown,
    daemonAndHarness: window.daemonAndHarness,
    wholeScenario: window.total,
  };
}

export async function gpuSnapshot(): Promise<Record<string, unknown>> {
  const binary = Bun.which("nvidia-smi");
  if (binary === null) return { available: false, attributionAvailable: false, reason: "nvidia-smi is unavailable" };
  const result = await command([
    binary,
    "--query-gpu=name,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (result.status !== 0) {
    return { available: false, attributionAvailable: false, reason: result.stderr || "nvidia-smi failed" };
  }
  return {
    available: true,
    attributionAvailable: false,
    reason: "nvidia-smi does not expose attributable graphics-process VRAM on this stack",
    systemTotals: result.stdout.split("\n").map((line) => {
      const [name, utilizationPercent, usedMiB, totalMiB] = line.split(",").map((value) => value.trim());
      return { name, utilizationPercent: Number(utilizationPercent), usedMiB: Number(usedMiB), totalMiB: Number(totalMiB) };
    }),
  };
}

function parseUserEnvironment(raw: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

export const HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE = [
  "Original Omarchy top bar remains clickable and visually available during Bot desktop start, work, switching, failure, and cleanup",
  "Existing Omarchy keyboard shortcuts continue to fire in the Host Session through the same lifecycle",
  "Ordinary host focus and physical pointer/keyboard input stay independent of Bot-generated input",
  "The user can switch Bots while using the host desktop and confirm selected pixels/input belong to the correct Bot",
  "Sibling Bot screenshots or service existence do not prove host usability",
] as const;

export async function observeHostSession(options?: {
  trackedSurfaceIds?: readonly SurfaceId[];
}): Promise<HostSessionObservation> {
  const envResult = Bun.which("systemctl") === null
    ? { status: 1, stdout: "", stderr: "systemctl is unavailable" }
    : await command(["systemctl", "--user", "show-environment"]);
  const environment = envResult.status === 0 ? parseUserEnvironment(envResult.stdout) : {};
  const wayland = environment.WAYLAND_DISPLAY ?? null;
  const runtimeDir = environment.XDG_RUNTIME_DIR ?? null;
  const botDisplayLeak: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (/wayland-\d+/.test(value) && key !== "WAYLAND_DISPLAY" && value !== wayland) {
      botDisplayLeak.push(`${key}=${value}`);
    }
    if (value.includes("omarchy-bot") && (key.includes("WAYLAND") || key.includes("XDG_RUNTIME"))) {
      botDisplayLeak.push(`${key}=${value}`);
    }
  }
  const unitNames = [
    "graphical-session.target",
    "hyprland.service",
    "wayland-wm@hyprland.desktop.service",
    "omarchy.service",
    "waybar.service",
  ];
  const units: HostSessionObservation["graphicalSession"]["units"] = [];
  for (const unit of unitNames) {
    if (Bun.which("systemctl") === null) {
      units.push({ unit, active: null });
      continue;
    }
    const result = await command(["systemctl", "--user", "is-active", unit]);
    units.push({ unit, active: result.stdout || null });
  }
  const visibleScreenUnits = await listScreenUnits();
  const leftoverScreenUnits = options?.trackedSurfaceIds === undefined
    ? []
    : visibleScreenUnits.filter((unit) =>
      options.trackedSurfaceIds!.some((surfaceId) => unit.includes(surfaceId.slice("surf_".length)))
    );
  return {
    observedAt: new Date().toISOString(),
    method: "systemctl --user show-environment / list-units / is-active",
    userManagerEnvironment: {
      available: envResult.status === 0,
      WAYLAND_DISPLAY: wayland,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_CURRENT_DESKTOP: environment.XDG_CURRENT_DESKTOP ?? null,
      DISPLAY: environment.DISPLAY ?? null,
      botDisplayLeak,
      rawStatus: envResult.status,
    },
    graphicalSession: { units },
    leftoverScreenUnits,
    visibleScreenUnits,
    cannotProve: [...HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE],
  };
}

export async function listScreenUnits(trackedSurfaceIds?: readonly SurfaceId[]): Promise<string[]> {
  if (Bun.which("systemctl") === null) return [];
  const result = await command([
    "systemctl",
    "--user",
    "list-units",
    "--all",
    "--full",
    "--plain",
    "--no-legend",
    "omarchy-bot-screen-*",
  ]);
  if (result.status !== 0 || result.stdout === "") return [];
  const units = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((unit): unit is string => unit !== undefined && unit.endsWith(".service"));
  if (trackedSurfaceIds === undefined) return units;
  return units.filter((unit) =>
    trackedSurfaceIds.some((surfaceId) => unit.includes(surfaceId.slice("surf_".length)))
  );
}

export function userSystemdManagerAvailable(): boolean {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return runtimeDir !== undefined && existsSync(path.join(runtimeDir, "systemd", "private"));
}

export function supervisionLabel(useHostApplicationUnits: boolean): SupervisionLabel {
  if (useHostApplicationUnits && userSystemdManagerAvailable()) {
    return {
      path: "production-style-application-units",
      useHostApplicationUnits: true,
      note: "Children are placed in Surface-owned transient user units via systemd-run --user and env -i. This is the deployment supervision path with private runtime/profile artifacts. It is not proof of top-bar or shortcut usability.",
    };
  }
  return {
    path: "harness-mode-direct-children",
    useHostApplicationUnits: false,
    note: "Standard integration harness disables host application units. Results are harness-mode evidence, not deployment-path supervision evidence.",
  };
}

export async function currentGeneration(harness: Harness, owner: ScreenOwner): Promise<number> {
  const row = harness.svc.db.query("SELECT runtime_generation FROM bot_surfaces WHERE surface_id = ?")
    .get(owner.surfaceId) as { runtime_generation: number };
  return row.runtime_generation;
}

export async function waitScreenReady(harness: Harness, owner: ScreenOwner): Promise<number> {
  const startedAt = performance.now();
  harness.svc.screens.open(owner);
  await until(async () => {
    const response = await authedFetch(harness, `${harness.baseUrl}/api/computer/state?botId=${owner.botId}&surfaceId=${owner.surfaceId}`);
    const view = await response.json() as { state?: string; activity?: string };
    if (view.state === "unavailable") {
      const runtime = harness.svc.screens.status(owner);
      if (runtime.state === "failed") throw new Error(runtime.failure);
      return undefined;
    }
    return view.state === "ready" ? true : undefined;
  }, 30_000, `Screen ${owner.surfaceId} did not become ready`);
  return Number((performance.now() - startedAt).toFixed(2));
}

export function findPortableSwayBundle(realHome: string): { swayBin: string; wlrRandrBin: string } | undefined {
  const root = path.join(realHome, ".local/share/omarchy-bot/runtime/sway");
  if (!existsSync(root)) return undefined;
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === "sway") candidates.push(full);
    }
  };
  visit(root);
  const preferWrapper = (swayBin: string): number => {
    const directory = path.dirname(swayBin);
    return path.basename(directory) === "bin" && !directory.endsWith(`${path.sep}usr${path.sep}bin`) ? 0 : 1;
  };
  candidates.sort((left, right) => preferWrapper(left) - preferWrapper(right));
  for (const swayBin of candidates) {
    const wlrRandrBin = path.join(path.dirname(swayBin), "wlr-randr");
    if (existsSync(wlrRandrBin)) return { swayBin, wlrRandrBin };
  }
  return undefined;
}

export function createBackgroundWorkFixture(root: string, browserBinary: string): string {
  const html = path.join(root, "background-work.html");
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>Bot background work</title>
<style>html{font:28px sans-serif;background:#102033;color:#fff}body{margin:0;min-height:24000px;background:repeating-linear-gradient(#102033 0 120px,#284d70 120px 240px)}#status{position:fixed;inset:20px 20px auto 20px;padding:20px;background:#000c;border:3px solid #7df}</style>
<div id="status">tick:0</div>
<script>
let n=0;
const s=document.querySelector('#status');
setInterval(()=>{
  n+=1;
  s.textContent='tick:'+n;
  s.style.background=n%2?'#8b1e3f':'#14532d';
}, 250);
for (const event of ['wheel','pointermove','keydown']) addEventListener(event,()=>{
  s.textContent=event+':'+(++n);
});
</script>`);
  const launcher = path.join(root, "bot-screen-background");
  writeFileSync(launcher, `#!/bin/sh
exec ${JSON.stringify(browserBinary)} --user-data-dir="$XDG_STATE_HOME/brave" --no-first-run --no-default-browser-check --disable-background-networking --disable-sync --password-store=basic --ozone-platform=wayland --app="file://${html}"
`);
  chmodSync(launcher, 0o755);
  return launcher;
}

export const HISTORICAL_FOUR_STREAM_BASELINE = {
  source: ".scratch/bot-screen-media-desktop/capacity-report.json",
  profile: "1080p",
  screens: 4,
  durationMs: 15050.5,
  interpretation: "Historical simultaneous four-stream row. Mixed attribution. Not an accepted normal-use budget and not compositor-only cost.",
  total: { pssMiB: 2102.74, rssMiB: 7854.19, cpuPercent: 413.37 },
  daemonAndHarness: { pssMiB: 356.26, rssMiB: 385.87, cpuPercent: 116.28 },
  publishedBreakdown: {
    compositorPssMiB: 193,
    encoderPssMiB: 569,
    workerApplicationPssMiB: 964,
    daemonAndHarnessPssMiB: 356,
  },
} as const;
