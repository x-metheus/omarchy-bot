import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceClientFrame } from "@omarchy-bot/protocol";
import { createLocalJobHandler, type LocalAsk, type LocalAskDecision } from "./handler.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Blocks on the gate fifo until the test releases it, so the write happens only when released. */
const COMMAND = "printf '%s' $$ > ready.txt; read line < gate; printf survived > always.txt";

/** A detached descendant that ignores SIGTERM and only writes its marker once released. */
const DESCENDANT_COMMAND = `sh -c 'trap "" TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & wait`;

/** Real child processes run on real time: the test polls OS state instead of guessing durations. */
const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(10);
  }
  return true;
};

const childAlive = (pid: number): boolean => {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
};

const alwaysRoot = (): { root: string; gate: number } => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-handler-"));
  roots.push(root);
  Bun.spawnSync(["mkfifo", path.join(root, "gate")]);
  writeFileSync(
    path.join(root, ".omarchy-bot-local-policy.json"),
    JSON.stringify({ always: [`run:${COMMAND}`], never: [] }),
  );
  // O_RDWR keeps the fifo open for the child so its open/read never blocks and released data is not lost.
  return { root, gate: openSync(path.join(root, "gate"), "r+") };
};

/** A root whose policy already remembers the descendant command, so it runs without an Ask. */
const descendantRoot = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-descendant-"));
  roots.push(root);
  writeFileSync(
    path.join(root, ".omarchy-bot-local-policy.json"),
    JSON.stringify({ always: [`run:${DESCENDANT_COMMAND}`], never: [] }),
  );
  return root;
};

describe("Local Sidecar remembered policy across restarts", () => {
  for (const decision of ["always", "never"] as const) {
    test(`${decision} survives restarting the handler with the same root`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-policy-restart-"));
      roots.push(root);
      const asks: LocalAsk[] = [];

      for (const jobId of ["before-restart", "after-restart"]) {
        const sent: DeviceClientFrame[] = [];
        const handler = createLocalJobHandler({
          root,
          approver: {
            ask(ask) {
              asks.push(ask);
              return Promise.resolve(decision);
            },
          },
          send: (frame) => sent.push(frame),
        });
        try {
          handler.receive({
            type: "local.job", jobId, action: "run", hostname: "laptop",
            botId: "bot_1", turnId: "turn_1", command: "echo persisted",
          });
          expect(await waitFor(() => sent.length > 0)).toBeTrue();
          expect(asks).toHaveLength(1);
          if (decision === "always") {
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ type: "local.result", jobId, ok: true, exitCode: 0 });
            const result = sent[0];
            if (result?.type !== "local.result" || !result.ok) throw new Error("remembered command failed");
            expect(result.text?.trim()).toBe("persisted");
          } else {
            expect(sent).toEqual([{ type: "local.result", jobId, ok: false, error: "Local Sidecar Never allowed this work" }]);
          }
        } finally {
          await handler.close();
        }
      }
    });
  }
});

describe.skipIf(process.platform !== "linux")("Local Sidecar remembered Always cancellation", () => {
  for (const stop of ["local.cancel", "handler.close"] as const) {
    test(`a remembered Always job is aborted by ${stop}`, async () => {
      const { root, gate } = alwaysRoot();
      const asks: LocalAsk[] = [];
      const sent: DeviceClientFrame[] = [];
      const handler = createLocalJobHandler({
        root,
        approver: {
          ask(ask) {
            asks.push(ask);
            return Promise.resolve("allow-once");
          },
        },
        send: (frame) => sent.push(frame),
      });

      try {
        handler.receive({
          type: "local.job",
          jobId: "job-always",
          action: "run",
          hostname: "laptop",
          botId: "bot_1",
          turnId: "turn_1",
          command: COMMAND,
        });

        const ready = path.join(root, "ready.txt");
        expect(await waitFor(() => {
          try {
            return readFileSync(ready, "utf8").trim().length > 0;
          } catch {
            return false;
          }
        })).toBeTrue();
        const pid = Number.parseInt(readFileSync(ready, "utf8").trim(), 10);
        expect(Number.isInteger(pid)).toBeTrue();
        expect(asks).toHaveLength(0);

        if (stop === "local.cancel") handler.receive({ type: "local.cancel", jobId: "job-always" });
        else await handler.close();

        writeSync(gate, "go\n");

        const settled = await waitFor(
          () => existsSync(path.join(root, "always.txt")) || !childAlive(pid),
        );
        expect(settled).toBeTrue();
        expect(existsSync(path.join(root, "always.txt"))).toBeFalse();
        expect(sent).toEqual([]);
      } finally {
        closeSync(gate);
      }
    });
  }
});

describe.skipIf(process.platform !== "linux")("Local Sidecar handler close teardown", () => {
  test("close awaits the killed descendant of a cancelled remembered-Always job", async () => {
    const root = descendantRoot();
    const sent: DeviceClientFrame[] = [];
    const handler = createLocalJobHandler({
      root,
      approver: { ask: () => Promise.resolve("allow-once") },
      send: (frame) => sent.push(frame),
    });

    handler.receive({
      type: "local.job",
      jobId: "job-descendant",
      action: "run",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
      command: DESCENDANT_COMMAND,
    });

    const pidFile = path.join(root, "descendant.pid");
    expect(await waitFor(() => existsSync(pidFile))).toBeTrue();
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isInteger(pid)).toBeTrue();
    expect(childAlive(pid)).toBeTrue();

    try {
      // The cancel removes the job from pending; its executor still owns the teardown.
      handler.receive({ type: "local.cancel", jobId: "job-descendant" });
      await handler.close();

      // close() resolves only after the teardown finished, so the descendant is already gone.
      expect(childAlive(pid)).toBeFalse();
      writeFileSync(path.join(root, "release"), "");
      // A survivor would write the marker within its poll interval, so watch for it.
      expect(await waitFor(() => existsSync(path.join(root, "marker.txt")), 1_000)).toBeFalse();
      expect(sent).toEqual([]);
    } finally {
      if (childAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
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
