import { afterEach, describe, expect, test } from "bun:test";
import { makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
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

  test("a second local.request for one tool call creates no second Sidecar job", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port);
    sidecars.push(sidecar);
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    const botId = await makeBot(h, "Dispatch once Bot");
    const pending = sendToBot(h, botId, "local.run:echo once");
    const first = await sidecar.waitForJob();
    const sent = await pending;
    const row = h.svc.db.query(
      `SELECT worker_session_id FROM turns WHERE id = ?`,
    ).get(sent.turnId) as { worker_session_id: string } | null;
    if (row === null || row.worker_session_id === null) throw new Error("working turn has no worker session");
    const worker = await h.svc.supervisor.agentWorker("pi");
    // The fake worker echoes an inbound local.request it did not originate.
    // Integration clock: the pipe has no completion event for a frame the worker drops.
    worker.write({
      type: "local.request",
      requestId: "req-local-duplicate",
      context: {
        botId,
        turnId: sent.turnId,
        workerSessionId: row.worker_session_id,
        toolCallId: `local-${sent.turnId}`,
      },
      action: "run",
      command: "echo twice",
    });
    const deadline = Date.now() + 1_000;
    while (sidecar.jobs().length < 2 && Date.now() <= deadline) await Bun.sleep(20);
    expect(sidecar.jobs().map((job) => job.command)).toEqual(["echo once"]);
    await sidecar.allowOnce(first.jobId);
    await waitThreadIdle(h, sent.threadId);
    const transcript = await messages(h, sent.threadId);
    expect(transcript.some((message) => (
      message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed"
    ))).toBeTrue();
    expect(sidecar.executed).toEqual(["echo once"]);
  });
});
