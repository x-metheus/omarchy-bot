export interface LocalExecutor {
  run(command: string, root: string, signal?: AbortSignal): Promise<{ ok: true; text: string; exitCode: number }>;
}

const GROUP_TERM_GRACE_MS = 200;
const GROUP_KILL_WAIT_MS = 2_000;

/** The stdin anchor reserves the private process group until teardown finishes. */
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

/** Escalate while the anchor still reserves the group, including orphaned descendants. */
async function terminateJob(group: number): Promise<void> {
  if (!signalGroup(group, "SIGTERM")) return;
  if (await waitForGroupExit(group, GROUP_TERM_GRACE_MS)) return;
  signalGroup(group, "SIGKILL");
  await waitForGroupExit(group, GROUP_KILL_WAIT_MS);
}

export const posixExecutor: LocalExecutor = {
  async run(command, root, signal) {
    const env = { ...process.env };
    delete env.OMARCHY_BOT_DEVICE_TOKEN;
    const proc = Bun.spawn(["/bin/sh", "-c", GROUP_LEADER, "sh", command], {
      cwd: root,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
      proc.stdin.end();
    }
  },
};
