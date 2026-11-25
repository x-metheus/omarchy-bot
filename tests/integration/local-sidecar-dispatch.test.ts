import { afterEach, describe, expect, test } from "bun:test";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { durableSuiteToolResults, installDurableSuiteProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
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
      expect(await durableSuiteToolResults(h.svc.db, sent.threadId)).toMatchObject([{
        role: "toolResult", toolName: "local", isError: false,
        content: [{ type: "text", text: expect.stringContaining("once") }],
        details: { deviceId: DEVICE_A, exitCode: 0 },
      }]);
    }
    const transcript = await messages(h, sent.threadId);
    expect(transcript.filter(({ kind }) => kind === "tool")).toMatchObject([{
      toolCall: { name: "local", status: "completed" },
    }]);
    expect(sidecar.jobs().map((job) => job.command)).toEqual(["echo once"]);
    expect(sidecar.executed).toEqual(["echo once"]);
  });
});

describe("local dispatch Turn identity", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];
  let restoreProvider: (() => void) | undefined;

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    try { await h?.stop(); }
    finally {
      h = undefined;
      restoreProvider?.();
      restoreProvider = undefined;
    }
  });

  test("forged bot or turn identity is rejected before any extra Sidecar job", async () => {
    if (!durable) restoreProvider = installDurableSuiteProvider();
    h = await startDaemon();
    if (!h.svc.credentials.getForRuntime("fake")) {
      await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    }
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    expect(await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" })).toMatchObject({ type: "registered", deviceId: DEVICE_A });
    const botId = await makeBot(h, "Turn identity Bot");
    const pending = sendToBot(h, botId, "local.run@this-device:echo once", DEVICE_A);
    const first = await sidecar.waitForJob();
    const sent = await pending;
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
  });
});
