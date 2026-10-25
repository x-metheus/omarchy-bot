/**
 * Fixtures for the Service supervision acceptance suite (ticket 02): /proc
 * ownership probes, TERM-resistant application fixtures, an unrelated sentinel,
 * and an isolated fixture user manager. Nothing here touches the host's
 * systemd or the host session.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function livePids(): number[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        return state !== "Z" && state !== "X";
      } catch {
        return false;
      }
    });
}

export function processRunning(pid: number): boolean {
  return livePids().includes(pid);
}

export function processEnvironment(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry !== "");
  } catch {
    return [];
  }
}

export function processCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((entry) => entry !== "");
  } catch {
    return [];
  }
}

/** Every live process whose private runtime directory lives under `root`. */
export function processesUnder(root: string): number[] {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return livePids().filter((pid) =>
    processEnvironment(pid).some((entry) =>
      entry.startsWith("XDG_RUNTIME_DIR=") && entry.slice("XDG_RUNTIME_DIR=".length).startsWith(prefix)
    )
  );
}

/** Every worker process the Service started for this isolated home. */
export function workerProcesses(home: string): number[] {
  return livePids().filter((pid) =>
    processCmdline(pid).some((arg) => arg.endsWith("worker.ts"))
    && processEnvironment(pid).includes(`OMARCHY_BOT_HOME=${home}`)
  );
}

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await Bun.sleep(50);
  }
}

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

/** Spawns a TERM-resistant descendant under `env -i`, so only its process group identifies it. */
function resistantDescendant(pidFile: string): string {
  return `env -i PIDFILE=${JSON.stringify(pidFile)} /bin/sh -c 'trap "" TERM; echo $$ > "$PIDFILE"; while :; do sleep 1; done' &`;
}

/** An application that leaves a TERM-resistant descendant and stays alive itself. */
export function writeResistantApplication(directory: string, pidFile: string): string {
  return executable(directory, "resistant-app", `#!/bin/sh
${resistantDescendant(pidFile)}
while :; do sleep 1; done
`);
}

/** An application whose leader exits at once, leaving a TERM-resistant descendant. */
export function writeOrphanApplication(directory: string, pidFile: string): string {
  return executable(directory, "orphan-app", `#!/bin/sh
${resistantDescendant(pidFile)}
exit 0
`);
}

export interface UnrelatedSentinel {
  pid: number;
  alive: () => boolean;
  stop: () => void;
}

/** A process the Service must never touch: different runtime dir, ignores TERM. */
export function startUnrelatedSentinel(directory: string): UnrelatedSentinel {
  const runtimeDir = path.join(directory, "unrelated-runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", "-c", 'trap "" TERM; while :; do sleep 1; done'], {
    env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtimeDir, OMARCHY_BOT_TEST_SENTINEL: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: proc.pid,
    alive: () => processRunning(proc.pid),
    stop: () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

export interface FakeManager {
  binDir: string;
  runtimeDir: string;
  /** Unit names the Service asked systemd-run for, in launch order. */
  units: () => string[];
  /** Full argv of each systemd-run invocation. */
  launches: () => string[][];
  /** systemctl invocations, verb first. */
  systemctlCalls: () => string[][];
  dispose: () => void;
}

/**
 * An isolated user-manager fixture: `systemd-run` records its arguments and
 * execs the `env -i …` command it was handed, `systemctl` records its verbs,
 * and a private socket marks the runtime directory as manager-backed.
 */
export function createFakeManager(): FakeManager {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-fake-manager-"));
  const binDir = path.join(root, "bin");
  const runtimeDir = path.join(root, "run");
  const logPath = path.join(root, "manager.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(runtimeDir, "systemd"), { recursive: true, mode: 0o700 });
  writeFileSync(logPath, "");
  // A socket exactly where ApplicationUnits looks for a user manager.
  const managerSocket = Bun.listen({
    unix: path.join(runtimeDir, "systemd", "private"),
    socket: { data() {} },
  });

  executable(binDir, "systemd-run", `#!/bin/sh
log=${JSON.stringify(logPath)}
{
  printf 'run'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\\n'
} >> "$log"
cwd=""
for arg in "$@"; do
  case "$arg" in
    --working-directory=*) cwd="\${arg#--working-directory=}" ;;
  esac
done
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ "$#" -gt 0 ] && shift
if [ -n "$cwd" ]; then cd "$cwd" || exit 1; fi
exec "$@"
`);

  executable(binDir, "systemctl", `#!/bin/sh
log=${JSON.stringify(logPath)}
{
  printf 'systemctl'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\\n'
} >> "$log"
exit 0
`);

  const lines = (): string[] => readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
  return {
    binDir,
    runtimeDir,
    units: () => lines()
      .filter((line) => line.startsWith("run "))
      .map((line) => line.split(" ").find((token) => token.startsWith("--unit="))?.slice("--unit=".length) ?? "")
      .filter((unit) => unit !== ""),
    launches: () => lines()
      .filter((line) => line.startsWith("run "))
      .map((line) => line.slice("run ".length).split(" ")),
    systemctlCalls: () => lines()
      .filter((line) => line.startsWith("systemctl "))
      .map((line) => line.slice("systemctl ".length).split(" ")),
    dispose: () => {
      managerSocket.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface ManagedService {
  baseUrl: string;
  /** Lines the fixture manager recorded, for unit-name and env-isolation assertions. */
  manager: FakeManager;
  stop: () => Promise<void>;
}

/**
 * Boots the real Service in its own process: `Bun.which` reads PATH once per
 * process, so a fixture manager on PATH must be present at process start.
 */
export async function startManagedService(input: {
  home: string;
  state: string;
  manager: FakeManager;
  binEnv: Record<string, string>;
  workersDir: string;
  runtimeRoot: string;
}): Promise<ManagedService> {
  const environment: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${input.manager.binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    ...input.binEnv,
    XDG_RUNTIME_DIR: input.manager.runtimeDir,
    HOME: input.home,
    OMARCHY_BOT_HOME: input.home,
    OMARCHY_BOT_STATE: input.state,
    OMARCHY_BOT_PORT: "0",
    OMARCHY_BOT_WORKERS_DIR: input.workersDir,
    OMARCHY_BOT_SCREEN_RUNTIME_DIR: input.runtimeRoot,
  };
  mkdirSync(path.join(input.home, "conformance"), { recursive: true });
  writeFileSync(
    path.join(input.home, "conformance", "pi-fake-pi-1.json"),
    JSON.stringify({ ok: true, image: "verified" }),
  );
  const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixtures/service-supervision/boot.ts")], {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const ready = Promise.withResolvers<string>();
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const newline = buffer.indexOf("\n");
        if (newline < 0) continue;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("SERVICE_READY ")) {
          ready.resolve(line);
          void reader.cancel().catch(() => {});
          return;
        }
      }
    } catch {
      // fall through to the exit/timeout race
    }
    ready.reject(new Error(`managed Service closed stdout before readiness: ${buffer.slice(-500)}`));
  })();
  const line = await Promise.race([
    ready.promise,
    proc.exited.then(async (code) => {
      throw new Error(`managed Service exited with ${code}: ${(await stderr).slice(-2_000)}`);
    }),
    Bun.sleep(30_000).then(() => {
      throw new Error("managed Service did not become ready");
    }),
  ]);
  const port = /SERVICE_READY (\d+)/.exec(line)?.[1];
  if (port === undefined) throw new Error(`managed Service did not report a port: ${line}`);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    manager: input.manager,
    stop: async () => {
      proc.kill("SIGINT");
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

export function fileLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}
