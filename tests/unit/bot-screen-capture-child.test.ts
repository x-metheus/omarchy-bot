import { describe, expect, test } from "bun:test";
import {
  captureChildExited,
  ProcessLineReader,
  spawnCaptureChild,
} from "../../apps/daemon/src/modules/computer/botScreenWaylandHelpers.ts";

const CAPTURE_CHILD = 'process.stdout.write("READY\\n"); setInterval(() => {}, 1_000);';
const TERM_RESISTANT_CAPTURE_CHILD =
  'process.on("SIGTERM", () => {}); process.stdout.write("READY\\n"); setInterval(() => {}, 1_000);';

/** Spawns a capture child that has installed its signal handling before it is aborted. */
async function startCaptureChild(body: string) {
  const child = Bun.spawn([process.execPath, "-e", body], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new ProcessLineReader(child.stdout).next()).toBe("READY");
  return child;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("capture child teardown", () => {
  test("kills a capture child whose signal was already aborted when it started", async () => {
    const controller = new AbortController();
    controller.abort(new Error("capture deadline already passed"));
    const child = await startCaptureChild(CAPTURE_CHILD);
    expect(running(child.pid)).toBeTrue();

    await captureChildExited(child, controller.signal);

    expect(child.signalCode).toBe("SIGTERM");
    expect(running(child.pid)).toBeFalse();
  }, 10_000);

  test("settles only once the aborted capture child has exited", async () => {
    const controller = new AbortController();
    const child = await startCaptureChild(CAPTURE_CHILD);

    const exited = captureChildExited(child, controller.signal);
    controller.abort();
    await exited;

    expect(child.signalCode).toBe("SIGTERM");
    expect(running(child.pid)).toBeFalse();
  }, 10_000);

  test("escalates to SIGKILL for an aborted capture child that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const child = await startCaptureChild(TERM_RESISTANT_CAPTURE_CHILD);

    const exited = captureChildExited(child, controller.signal);
    controller.abort();
    await exited;

    expect(child.signalCode).toBe("SIGKILL");
    expect(running(child.pid)).toBeFalse();
  }, 10_000);

  test("kills a capture child whose signal aborted while it was being created", async () => {
    const controller = new AbortController();
    const { child, exited } = spawnCaptureChild(() => {
      const created = Bun.spawn([process.execPath, "-e", CAPTURE_CHILD], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      // The deadline lands after the child exists, before any kill hook runs.
      controller.abort(new Error("capture deadline passed during spawn"));
      return created;
    }, controller.signal);
    expect(running(child.pid)).toBeTrue();

    await exited;

    expect(child.signalCode).toBe("SIGTERM");
    expect(running(child.pid)).toBeFalse();
  }, 10_000);
});
