import { afterEach, describe, expect, test } from "bun:test";
import { durableSuiteToolResults } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { isLocalJob, LOCAL_SCHEMA } from "../../packages/agent-contract/src/local-protocol.ts";
import { makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const durable = process.env.OMARCHY_TEST_DURABLE === "1";

describe("local dispatch once per tool call", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  test("one local tool call creates exactly one Sidecar job and records its result", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" });
    const botId = await makeBot(h, "Dispatch once Bot");
    const pending = sendToBot(h, botId, "local.run:echo once", DEVICE_A);
    const first = await sidecar.waitForJob();
    const sent = await pending;
    if (!durable) {
      const row = h.svc.db.query(
        `SELECT worker_session_id FROM turns WHERE id = ?`,
      ).get(sent.turnId) as { worker_session_id: string } | null;
      if (row === null || row.worker_session_id === null) throw new Error("working turn has no worker session");
      const worker = await h.svc.supervisor.agentWorker("pi");
      worker.write({
        type: "tool.request",
        requestId: "req-local-duplicate",
        name: "local",
        params: { action: "run", command: "echo twice" },
        context: {
          botId,
          turnId: sent.turnId,
          workerSessionId: row.worker_session_id,
          toolCallId: `local-${sent.turnId}`,
        },
      });
      const deadline = Date.now() + 4_000;
      const rejection = (): { error?: string } | undefined => worker.sent.find((entry) => {
        const frame = entry as { type?: string; requestId?: string };
        return frame.type === "tool.result" && frame.requestId === "req-local-duplicate";
      }) as { error?: string } | undefined;
      while (rejection() === undefined) {
        if (Date.now() > deadline) throw new Error("duplicate local tool.request was not rejected");
        await Bun.sleep(20);
      }
      expect(rejection()?.error).toBe("tool call was already dispatched");
    }
    await sidecar.allowOnce(first.jobId);
    await waitThreadIdle(h, sent.threadId);
    if (durable) {
      // Task 11 projects the tool record into the Service transcript. Assert the committed pi result here.
      expect(await durableSuiteToolResults(h.svc.db, sent.threadId)).toMatchObject([{
        role: "toolResult", toolName: "local", isError: false,
        content: [{ type: "text", text: expect.stringContaining("once") }],
        details: { deviceId: DEVICE_A, exitCode: 0 },
      }]);
    } else {
      const transcript = await messages(h, sent.threadId);
      expect(transcript.some((message) => (
        message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed"
      ))).toBeTrue();
    }
    expect(sidecar.jobs().map((job) => job.command)).toEqual(["echo once"]);
    expect(sidecar.executed).toEqual(["echo once"]);
  });
});

describe("local dispatch Turn identity", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  test("forged bot or turn identity is rejected before any extra Sidecar job", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    expect(await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" })).toMatchObject({ type: "registered", deviceId: DEVICE_A });
    const botId = await makeBot(h, "Turn identity Bot");
    const pending = sendToBot(h, botId, durable ? "local.run@this-device:echo once" : "local.run:echo once", DEVICE_A);
    const first = await sidecar.waitForJob();
    const sent = await pending;
    if (durable) {
      expect(Object.keys(LOCAL_SCHEMA.properties)).not.toContain("botId");
      expect(Object.keys(LOCAL_SCHEMA.properties)).not.toContain("turnId");
      const args = { action: "run", command: "echo forged" };
      expect(isLocalJob(args)).toBeTrue();
      expect(isLocalJob({ ...args, botId: "wrong-bot" })).toBeFalse();
      expect(isLocalJob({ ...args, turnId: "wrong-turn" })).toBeFalse();
      // The job frame's device ID is implicit in its registered connection.
      expect(first).toMatchObject({ botId, turnId: sent.turnId, command: "echo once" });
      await sidecar.allowOnce(first.jobId);
      expect(await h.svc.turns.waitForTerminal(sent.turnId)).toMatchObject({ status: "completed" });

      sidecar.autoAllow();
      const forged = await sendToThread(h, sent.threadId, "local.run.forged:echo forged", DEVICE_A);
      expect(await h.svc.turns.waitForTerminal(forged.turnId)).toMatchObject({ status: "completed" });
      expect(await durableSuiteToolResults(h.svc.db, sent.threadId)).toMatchObject([
        { role: "toolResult", toolName: "local", isError: false, details: { deviceId: DEVICE_A } },
        { role: "toolResult", toolName: "local", isError: true, content: [{ type: "text", text: expect.stringContaining('Validation failed for tool "local"') }] },
      ]);
      expect(sidecar.jobs()).toEqual([first]);
      return;
    }
    const row = h.svc.db.query(
      `SELECT worker_session_id FROM turns WHERE id = ?`,
    ).get(sent.turnId) as { worker_session_id: string } | null;
    if (row === null || row.worker_session_id === null) throw new Error("working turn has no worker session");
    const workerSessionId = row.worker_session_id;
    const worker = await h.svc.supervisor.agentWorker("pi");

    /** Start a fresh local tool call through the public Agent-event flow. */
    const startCall = (id: string): void => {
      h?.svc.turns.onAgentEvent("pi", {
        type: "tool.started",
        sessionId: workerSessionId,
        id,
        name: "local",
        status: "running",
      });
    };
    const resultOf = (requestId: string): { ok?: boolean; error?: string } | undefined =>
      worker.sent.find((entry) => {
        const frame = entry as { type?: string; requestId?: string };
        return frame.type === "tool.result" && frame.requestId === requestId;
      }) as { ok?: boolean; error?: string } | undefined;
    const awaitResult = async (requestId: string): Promise<{ ok?: boolean; error?: string }> => {
      const deadline = Date.now() + 4_000;
      while (resultOf(requestId) === undefined) {
        if (Date.now() > deadline) throw new Error(`no tool.result for ${requestId}`);
        await Bun.sleep(20);
      }
      return resultOf(requestId)!;
    };
    const request = (requestId: string, toolCallId: string, context: { botId: string; turnId: string }): void => {
      worker.write({
        type: "tool.request",
        requestId,
        name: "local",
        params: { action: "run", command: `echo ${requestId}` },
        context: { ...context, workerSessionId, toolCallId },
      });
    };
    /**
     * Wait for the outcome of one request: either its tool.result, or a Sidecar
     * job the request wrongly dispatched. A wrong dispatch is concrete evidence
     * of a missing identity guard, not a timeout.
     */
    const awaitOutcome = async (
      requestId: string,
      jobsBefore: number,
    ): Promise<{ result?: { ok?: boolean; error?: string }; job?: { botId: string; turnId: string; command?: string } }> => {
      const deadline = Date.now() + 4_000;
      for (;;) {
        const result = resultOf(requestId);
        if (result !== undefined) return { result };
        const job = sidecar.jobs().slice(jobsBefore)[0];
        if (job !== undefined) return { job };
        if (Date.now() > deadline) throw new Error(`no tool.result and no Sidecar job for ${requestId}`);
        await Bun.sleep(20);
      }
    };

    startCall("forged-bot-call");
    request("req-forged-bot", "forged-bot-call", { botId: "wrong-bot", turnId: sent.turnId });
    const forgedBot = await awaitOutcome("req-forged-bot", sidecar.jobs().length);
    expect(forgedBot.job).toBeUndefined();
    expect(forgedBot.result?.ok).toBeFalse();
    expect(forgedBot.result?.error).toBe("local tool context is stale or mismatched");
    expect(sidecar.jobs()).toHaveLength(1);

    startCall("forged-turn-call");
    request("req-forged-turn", "forged-turn-call", { botId, turnId: "wrong-turn" });
    const forgedTurn = await awaitOutcome("req-forged-turn", sidecar.jobs().length);
    expect(forgedTurn.job).toBeUndefined();
    expect(forgedTurn.result?.ok).toBeFalse();
    expect(forgedTurn.result?.error).toBe("local tool context is stale or mismatched");
    expect(sidecar.jobs()).toHaveLength(1);

    startCall("legit-call");
    request("req-legit", "legit-call", { botId, turnId: sent.turnId });
    const second = await sidecar.waitForJob();
    expect(second.command).toBe("echo req-legit");
    expect(second.botId).toBe(botId);
    expect(second.turnId).toBe(sent.turnId);
    expect(sidecar.jobs()).toHaveLength(2);
    await sidecar.allowOnce(second.jobId);
    const legit = await awaitResult("req-legit");
    expect(legit.ok).toBeTrue();

    await sidecar.allowOnce(first.jobId);
  });
});
