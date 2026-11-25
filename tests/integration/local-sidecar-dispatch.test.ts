import { afterEach, describe, expect, test } from "bun:test";
import { durableSuiteToolResults } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { isLocalJob, LOCAL_SCHEMA } from "../../packages/agent-contract/src/local-protocol.ts";
import { makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    await sidecar.allowOnce(first.jobId);
    await waitThreadIdle(h, sent.threadId);
    expect(await durableSuiteToolResults(h.svc.db, sent.threadId)).toMatchObject([{
      role: "toolResult", toolName: "local", isError: false,
      content: [{ type: "text", text: expect.stringContaining("once") }],
      details: { deviceId: DEVICE_A, exitCode: 0 },
    }]);
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
    expect((await messages(h, sent.threadId)).filter(({ kind }) => kind === "tool")).toMatchObject([
      { toolCall: { name: "local", status: "completed", target: "laptop echo once" } },
      { toolCall: { name: "local", status: "error", target: "echo forged" } },
    ]);
    expect(h.svc.db.query("SELECT turn_id FROM messages WHERE thread_id = ? AND kind = 'tool' ORDER BY seq").all(sent.threadId))
      .toEqual([{ turn_id: sent.turnId }, { turn_id: forged.turnId }]);
    expect(sidecar.jobs()).toEqual([first]);
  });
});
