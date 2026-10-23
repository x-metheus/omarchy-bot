import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
