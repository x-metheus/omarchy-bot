import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_RESULT_TEXT_MAX, type DeviceLocalJobFrame } from "@omarchy-bot/protocol";
import { confinedPath } from "@omarchy-bot/domain";

const SECRET_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws", ".config"]);
const SEARCH_HIT_LIMIT = 32;
const SNIPPET_MAX = 160;
const GROUP_TERM_GRACE_MS = 200;
const GROUP_KILL_WAIT_MS = 2_000;

export function ruleKey(job: Pick<DeviceLocalJobFrame, "action" | "command" | "path" | "query">): string {
  return `${job.action}:${job.command ?? job.path ?? job.query ?? ""}`;
}

/**
 * Group leader for one job. The detached child leads its own session, so its
 * pid is the group id. It starts a small anchor that ignores SIGTERM and reads
 * our stdin, which keeps the group id reserved for the whole job: a cancel can
 * then never signal a group recycled by an unrelated process. Closing stdin
 * releases the anchor once the job is done.
 */
const GROUP_LEADER = [
  "trap '' HUP TERM",
  "sh -c 'while read -r _; do :; done' <&0 >/dev/null 2>&1 &",
  "trap - HUP TERM",
  'exec sh -c "$1" </dev/null',
].join("\n");

/** Signal a group; false once it is empty, any other failure is real. */
function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (signalGroup(group, 0)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
  return true;
}

/**
 * Cancel a job's private process group: SIGTERM, then a bounded SIGKILL for
 * descendants that ignore it or outlive the shell. The anchor keeps the group
 * alive through the grace period, so escalation still reaches them.
 */
async function terminateJob(group: number): Promise<void> {
  if (!signalGroup(group, "SIGTERM")) return;
  if (await waitForGroupExit(group, GROUP_TERM_GRACE_MS)) return;
  signalGroup(group, "SIGKILL");
  await waitForGroupExit(group, GROUP_KILL_WAIT_MS);
}

export async function executeLocalJob(
  job: DeviceLocalJobFrame,
  root: string,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string; exitCode?: number } | { ok: false; error: string }> {
  try {
    signal?.throwIfAborted();
    if (/\bscreenshot\b|\bpointer\b|SWAYSOCK|WAYLAND_DISPLAY/i.test(`${job.command ?? ""} ${job.path ?? ""}`)) {
      return { ok: false, error: "Local Sidecar rejects screenshot, pointer, and Host compositor actions" };
    }
    if (job.action === "run") {
      if (job.command === undefined) return { ok: false, error: "local.run requires a command" };
      const proc = Bun.spawn(["/bin/sh", "-c", GROUP_LEADER, "sh", job.command], {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // A private process group lets a cancel reach the command's descendants.
        detached: true,
      });
      const group = proc.pid;
      const finished = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const aborted = Promise.withResolvers<never>();
      let settled = false;
      let teardown: Promise<void> | undefined;
      const rejectAborted = (): void => {
        if (settled) return;
        settled = true;
        aborted.reject(signal?.reason ?? new Error("Local Sidecar job aborted"));
      };
      const stop = (): void => {
        teardown ??= terminateJob(group);
        void teardown.then(rejectAborted, rejectAborted);
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        const [stdout, stderr, exitCode] = await Promise.race([
          finished.then((result) => {
            settled = true;
            return result;
          }),
          aborted.promise,
        ]);
        signal?.throwIfAborted();
        return { ok: true, text: `${stdout}${stderr}`.slice(0, 8_192), exitCode };
      } finally {
        signal?.removeEventListener("abort", stop);
        if (teardown !== undefined) await teardown;
        // Releasing stdin lets the anchor exit, so the group is freed.
        proc.stdin.end();
      }
    }
    if (job.action === "search") {
      if (job.query === undefined) return { ok: false, error: "local.search requires a query" };
      return { ok: true, text: searchSandbox(job.query, root, job.path) };
    }
    if (job.action === "read") {
      if (job.path === undefined) return { ok: false, error: "local.read requires an explicit path" };
      return { ok: true, text: readFileSync(confinedPath(job.path, root), "utf8").slice(0, 8_192) };
    }
    if (job.action === "write") {
      if (job.path === undefined) return { ok: false, error: "local.write requires an explicit path" };
      signal?.throwIfAborted();
      const target = confinedPath(job.path, root);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, job.contents ?? "");
      return { ok: true, text: `wrote ${job.path}` };
    }
    if (job.action === "transfer") {
      if (job.direction === "from-workspace") {
        if (job.destination === undefined) {
          return { ok: false, error: "transfer onto a Sidecar requires an explicit destination path" };
        }
        signal?.throwIfAborted();
        const target = confinedPath(job.destination, root);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, job.contents ?? "");
        return { ok: true, text: `copied to ${job.destination}` };
      }
      if (job.path === undefined) {
        return { ok: false, error: "transfer into Shared Workspace requires a Sidecar source path" };
      }
      const text = readFileSync(confinedPath(job.path, root), "utf8");
      if (text.length > LOCAL_RESULT_TEXT_MAX) {
        return { ok: false, error: `transfer exceeds the ${LOCAL_RESULT_TEXT_MAX} character result frame` };
      }
      return { ok: true, text };
    }
    return { ok: false, error: `unsupported local action ${job.action}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function searchSandbox(query: string, root: string, explicitRoot?: string): string {
  if (explicitRoot === "/" || query === "/") {
    throw new Error("Local Sidecar search cannot scan /");
  }
  const start = confinedPath(explicitRoot ?? ".", root);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    if (hits.length >= SEARCH_HIT_LIMIT) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= SEARCH_HIT_LIMIT) return;
      if (SECRET_DIR_NAMES.has(name)) continue;
      const full = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      let body = "";
      try {
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!full.includes(query) && !body.includes(query)) continue;
      const relative = path.relative(root, full);
      const line = body.split("\n").find((candidate) => candidate.includes(query)) ?? "";
      hits.push(`${relative}: ${line.slice(0, SNIPPET_MAX)}`);
    }
  };
  walk(start);
  return hits.join("\n").slice(0, 8_192);
}
