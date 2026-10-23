import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_RESULT_TEXT_MAX, type DeviceLocalJobFrame } from "@omarchy-bot/protocol";
import { executeLocalJob } from "./execute.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function transferJob(file: string): DeviceLocalJobFrame {
  return {
    type: "local.job" as const,
    jobId: "job-1",
    action: "transfer" as const,
    hostname: "laptop",
    botId: "bot",
    turnId: "turn",
    path: file,
    destination: "inbox/big.txt",
    direction: "to-workspace" as const,
  };
}

describe("executeLocalJob transfer frame bound", () => {
  test("refuses a to-workspace file that exceeds the result frame", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-transfer-"));
    roots.push(root);
    writeFileSync(path.join(root, "big.txt"), "x".repeat(LOCAL_RESULT_TEXT_MAX + 1));
    const result = await executeLocalJob(transferJob("big.txt"), root);
    expect(result).toEqual({
      ok: false,
      error: `transfer exceeds the ${LOCAL_RESULT_TEXT_MAX} character result frame`,
    });
  });

  test("returns a to-workspace file that fits the result frame", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-transfer-"));
    roots.push(root);
    const text = "y".repeat(LOCAL_RESULT_TEXT_MAX);
    writeFileSync(path.join(root, "fit.txt"), text);
    const result = await executeLocalJob(transferJob("fit.txt"), root);
    expect(result).toEqual({ ok: true, text });
  });

  test("an aborted run kills the child and does not succeed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-abort-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-abort",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: "sleep 30",
    }, root, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBeFalse();
  });
});

/** A background descendant that ignores SIGTERM and only writes once released. */
const DESCENDANT_COMMAND =
  "sh -c 'trap \"\" TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & wait";

/** The same descendant, but the shell exits at once and leaves it behind. */
const SHELL_EXITS_FIRST_COMMAND =
  "sh -c 'trap \"\" HUP TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & echo $$ > shell.pid; exit 0";

function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X";
  } catch {
    return false;
  }
}

/** Poll a condition; readiness and exit are witnessed, never slept on. */
async function until(probe: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

/** Bound a promise so a stuck job fails loudly instead of hanging the suite. */
async function withDeadline<T>(operation: Promise<T>, message: string, timeoutMs = 10_000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe("executeLocalJob descendant teardown", () => {
  test("aborting a run stops descendants that ignore SIGTERM", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-descendant-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-descendant",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: DESCENDANT_COMMAND,
    }, root, controller.signal);
    let descendantPid: number | undefined;
    try {
      await until(() => existsSync(path.join(root, "descendant.pid")), "descendant never became ready");
      descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      expect(Number.isSafeInteger(descendantPid)).toBeTrue();
      expect(processAlive(descendantPid)).toBeTrue();

      controller.abort();
      await until(() => !processAlive(descendantPid!), "descendant survived the aborted job");

      const result = await withDeadline(pending, "aborted run never settled");
      expect(result.ok).toBeFalse();

      writeFileSync(path.join(root, "release"), "");
      expect(existsSync(path.join(root, "marker.txt"))).toBeFalse();
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 30_000);

  test("cancelling still reaches descendants after the shell has exited", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-orphan-"));
    roots.push(root);
    const controller = new AbortController();
    const pending = executeLocalJob({
      type: "local.job",
      jobId: "job-orphan",
      action: "run",
      hostname: "laptop",
      botId: "bot",
      turnId: "turn",
      command: SHELL_EXITS_FIRST_COMMAND,
    }, root, controller.signal);
    let descendantPid: number | undefined;
    try {
      await until(
        () => existsSync(path.join(root, "descendant.pid")) && existsSync(path.join(root, "shell.pid")),
        "the shell and its descendant never started",
      );
      descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      const shellPid = Number(readFileSync(path.join(root, "shell.pid"), "utf8").trim());
      expect(Number.isSafeInteger(descendantPid)).toBeTrue();
      expect(Number.isSafeInteger(shellPid)).toBeTrue();
      await until(() => !processAlive(shellPid), "the shell never exited");
      expect(processAlive(descendantPid)).toBeTrue();

      controller.abort();
      await until(() => !processAlive(descendantPid!), "descendant outlived the aborted job");

      const result = await withDeadline(pending, "aborted run never settled");
      expect(result.ok).toBeFalse();

      writeFileSync(path.join(root, "release"), "");
      expect(existsSync(path.join(root, "marker.txt"))).toBeFalse();
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 30_000);
});
