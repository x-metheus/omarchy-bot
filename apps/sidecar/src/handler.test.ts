import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceClientFrame } from "@omarchy-bot/protocol";
import { createLocalJobHandler, type LocalAsk, type LocalAskDecision } from "./handler.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Local Sidecar job handler cancel", () => {
  test("cancelling during Ask dismisses the card and a late Allow neither writes nor persists policy", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-handler-"));
    roots.push(root);
    const asks: LocalAsk[] = [];
    const decisions: Array<(decision: LocalAskDecision) => void> = [];
    const sent: DeviceClientFrame[] = [];
    const handler = createLocalJobHandler({
      root,
      approver: {
        ask(ask) {
          asks.push(ask);
          const decision = Promise.withResolvers<LocalAskDecision>();
          decisions.push(decision.resolve);
          return decision.promise;
        },
      },
      send: (frame) => sent.push(frame),
    });

    handler.receive({
      type: "local.job",
      jobId: "job-1",
      action: "write",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
      path: "late.txt",
      contents: "late-allow",
    });
    expect(asks).toHaveLength(1);
    const dismissed = asks[0]!.dismissed.then(() => true);

    handler.receive({ type: "local.cancel", jobId: "job-1" });
    expect(asks[0]!.signal.aborted).toBeTrue();
    expect(await dismissed).toBeTrue();

    decisions[0]!("always");
    await Promise.resolve();

    expect(existsSync(path.join(root, "late.txt"))).toBeFalse();
    expect(existsSync(path.join(root, ".omarchy-bot-local-policy.json"))).toBeFalse();
    expect(sent).toEqual([]);
  });
});
