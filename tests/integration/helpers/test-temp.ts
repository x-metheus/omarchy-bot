import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Each `bun test` run keeps its temporary files in its own folder, `<tmpdir>/ob-tests/<pid>`, so a run that is
 * killed can be cleaned up by the next one without guessing which folders belong to tests. The name stays short
 * because some tests create Unix sockets under temporary folders.
 */
export const TEST_TEMP_RUN_ENV = "OMARCHY_TEST_TEMP_RUN";
const RUNS_FOLDER = "ob-tests";
// A run older than this is gone even if its process id was reused by another process.
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove run folders whose `bun test` process has exited, or that are older than a day. Returns what it removed. */
export function sweepStaleTestRuns(root: string, now = Date.now(), alive = processAlive): string[] {
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const uid = process.getuid?.();
  const removed: string[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(root, name);
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
    if (alive(Number(name)) && now - stat.mtimeMs < MAX_RUN_AGE_MS) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/**
 * Give this `bun test` run its own temporary folder, after removing folders left by killed runs. Child processes
 * inherit the folder through TMPDIR, and a nested `bun test` reuses it. `onExit` registers the folder's removal for
 * when the run ends.
 */
export function claimTestTempRun({
  env = process.env,
  root = path.join(os.tmpdir(), RUNS_FOLDER),
  onExit = (fn: () => void) => { process.on("exit", fn); },
}: {
  env?: Record<string, string | undefined>;
  root?: string;
  onExit?: (fn: () => void) => void;
} = {}): string | undefined {
  if (env[TEST_TEMP_RUN_ENV]) return undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  sweepStaleTestRuns(root);
  const run = path.join(root, String(process.pid));
  // A folder with this process id belongs to an earlier process that had the same id.
  rmSync(run, { recursive: true, force: true });
  mkdirSync(run, { mode: 0o700 });
  env[TEST_TEMP_RUN_ENV] = run;
  env.TMPDIR = run;
  onExit(() => { rmSync(run, { recursive: true, force: true }); });
  return run;
}
