import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import type { SurfaceId } from "../../packages/domain/src/index.ts";
import type { MessageDto } from "../../packages/protocol/src/index.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { api, makeBot, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { createComputerTool } from "../../workers/pi/src/computer-tool.ts";
import { until } from "./helpers/bot-screen-load-observe.ts";

interface ComputerView {
  botId: string;
  surfaceId: SurfaceId;
  state: string;
  takeover: "unavailable" | "available" | "active";
}

async function computerRequest(
  h: Harness,
  owner: { botId: string; surfaceId: SurfaceId },
  method: "GET" | "POST",
  path: string,
): Promise<{ response: Response; body: ComputerView | { error: string } }> {
  const query = `botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`;
  const response = await fetch(`${h.baseUrl}${path}?${query}`, { method });
  return { response, body: await response.json() };
}

async function waitForTakeover(
  h: Harness,
  owner: { botId: string; surfaceId: SurfaceId },
  expected: ComputerView["takeover"],
): Promise<ComputerView> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await computerRequest(h, owner, "GET", "/api/computer/state");
    if ("takeover" in result.body && result.body.takeover === expected) return result.body;
    if (Date.now() >= deadline) {
      throw new Error(`Takeover did not reach ${expected}`);
    }
  }
}

async function botSurface(h: Harness, botId: string): Promise<SurfaceId> {
  const bot = await api<{ surfaceId: SurfaceId }>(h, "GET", `/api/bots/${botId}`);
  return bot.surfaceId;
}

function coordination(h: Harness, surfaceId: SurfaceId): {
  authority_kind: "idle" | "agent" | "web" | "takeover";
} | null {
  return h.svc.db
    .query(
      `SELECT authority_kind
       FROM computer_surface_coordination WHERE surface_id = ?`,
    )
    .get(surfaceId) as {
      authority_kind: "idle" | "agent" | "web" | "takeover";
    } | null;
}


function artifactCount(h: Harness, surfaceId: SurfaceId): number {
  const row = h.svc.db
    .query(`SELECT COUNT(*) AS count FROM artifacts WHERE surface_id = ?`)
    .get(surfaceId) as { count: number };
  return row.count;
}

async function messages(h: Harness, threadId: string): Promise<MessageDto[]> {
  return api<MessageDto[]>(h, "GET", `/api/threads/${threadId}/messages`);
}

describe("Bot-bound Pi computer tool", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("Pi receives the actual desktop generation after a computer restart without changing conversation binding", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Desktop identity Bot");
    const surfaceId = await botSurface(h, botId);
    const otherBotId = await makeBot(h, "Unobserved Bot");
    const otherSurfaceId = await botSurface(h, otherBotId);
    const owner = { botId, surfaceId };
    const binding = { ...owner, turnId: "identity-turn", workerSessionId: "same-conversation" };
    const broker = h.svc.computer;
    const tool = createComputerTool(() => binding, {
      request: (context, action, signal) =>
        broker.agentToolAct(owner, context.turnId, context.toolCallId, action, signal ?? new AbortController().signal),
    });

    expect(h.svc.screens.status(owner)).toEqual({ state: "stopped" });
    const observe = async (toolCallId: string) => tool.execute(
      toolCallId,
      { action: "observe" },
      undefined,
      undefined,
      undefined as never,
    );
    const first = await observe("identity-1");
    expect(first.details.desktopSession).toEqual({ ...owner, runtimeGeneration: 1 });
    const firstText = first.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(firstText).toContain(JSON.stringify({ ...owner, runtimeGeneration: 1 }));
    expect(firstText).not.toContain(otherSurfaceId);
    expect(first.content.some((item) => item.type === "image")).toBeTrue();

    // A real click on the first runtime proves the input authority of generation 1.
    const firstClick = await tool.execute(
      "identity-click-1",
      { action: "click", args: { x: 3, y: 4 } },
      undefined,
      undefined,
      undefined as never,
    );
    expect(firstClick.details.desktopSession).toEqual({ ...owner, runtimeGeneration: 1 });
    expect(adapter.inputEvents.filter((event) => event.runtimeGeneration === 1)).toHaveLength(3);

    // Only a new Bot Computer advances the generation the tool reports.
    adapter.exitCompositor(surfaceId);
    await until(
      () => adapter.running(surfaceId) === undefined ? true : undefined,
      5_000,
      "failed Screen runtime was not cleaned",
    );
    const second = await observe("identity-2");
    expect(second.details.desktopSession).toEqual({ ...owner, runtimeGeneration: 2 });
    const secondText = second.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(secondText).toContain(JSON.stringify({ ...owner, runtimeGeneration: 2 }));
    expect(secondText).not.toContain(otherSurfaceId);
    expect(second.content.some((item) => item.type === "image")).toBeTrue();

    // A real click on the replacement runtime must get its own input authority.
    const secondClick = await tool.execute(
      "identity-click-2",
      { action: "click", args: { x: 3, y: 4 } },
      undefined,
      undefined,
      undefined as never,
    );
    expect(secondClick.details.desktopSession).toEqual({ ...owner, runtimeGeneration: 2 });
    expect(adapter.inputEvents.filter((event) => event.runtimeGeneration === 1)).toHaveLength(3);
    expect(adapter.inputEvents.filter((event) => event.runtimeGeneration === 2)).toHaveLength(3);
    expect(adapter.inputEvents.map((event) => event.surfaceId)).toEqual([
      surfaceId,
      surfaceId,
      surfaceId,
      surfaceId,
      surfaceId,
      surfaceId,
    ]);

    expect(h.svc.screens.status({ botId: otherBotId, surfaceId: otherSurfaceId })).toEqual({ state: "stopped" });
  });

  test("a public Agent turn observes and inputs only through its owning Bot Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const firstBot = await makeBot(h, "First tool Bot");
    const secondBot = await makeBot(h, "Second tool Bot");
    const firstSurface = await botSurface(h, firstBot);
    const secondSurface = await botSurface(h, secondBot);

    const observed = await sendToBot(h, firstBot, "computer:observe");
    await waitThreadIdle(h, observed.threadId);
    const acted = await sendToBot(h, secondBot, "computer:click:second");
    await waitThreadIdle(h, acted.threadId);

    expect(adapter.captureStarts(firstSurface)).toBe(1);
    expect(adapter.actionsStarted).toBe(1);
    expect(adapter.inputEvents.map((record) => record.surfaceId)).toEqual([
      secondSurface,
      secondSurface,
      secondSurface,
    ]);
    const transcript = await messages(h, observed.threadId);
    expect(transcript.some((message) =>
      message.text?.includes(firstSurface) && message.text.includes("imageRef")
    )).toBeTrue();
    expect(transcript.some((message) => message.kind === "tool" && message.toolCall?.name === "computer")).toBeTrue();
  });

  test("one shared seat orders Agent input across Screens while one Screen stays ordered", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const firstBot = await makeBot(h, "Concurrent first Bot");
    const secondBot = await makeBot(h, "Concurrent second Bot");
    const firstSurface = await botSurface(h, firstBot);
    const secondSurface = await botSurface(h, secondBot);
    adapter.blockInputs();
    const turnsPromise = Promise.all([
      sendToBot(h, firstBot, "computer:click:first-a"),
      sendToBot(h, firstBot, "computer:click:first-b"),
      sendToBot(h, secondBot, "computer:click:second"),
    ]);
    await adapter.waitForInputAttempts(1);
    expect(adapter.maximumInputsInFlight).toBe(1);
    expect(adapter.maximumInputSurfacesInFlight).toBe(1);
    adapter.releaseInputs();
    const turns = await turnsPromise;
    await Promise.all(turns.map((turn) => waitThreadIdle(h!, turn.threadId)));

    expect(adapter.inputEvents.filter((record) => record.surfaceId === firstSurface)).toHaveLength(6);
    expect(adapter.inputEvents.filter((record) => record.surfaceId === secondSurface)).toHaveLength(3);
  });

  test("cancelling a pending serialized tool call prevents its input from dispatching", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const bot = await makeBot(h, "Cancelled tool Bot");
    const surfaceId = await botSurface(h, bot);
    adapter.blockInputs();

    try {
      const first = await sendToBot(h, bot, "computer:click:first");
      await adapter.waitForInputAttempts(1);
      const cancelled = await sendToBot(h, bot, "computer:click:cancelled");
      await h.svc.turns.abortTurn(cancelled.turnId, "cancel pending computer tool");
      adapter.releaseInputs();
      await Promise.all([
        waitThreadIdle(h, first.threadId),
        waitThreadIdle(h, cancelled.threadId),
      ]);

      expect(adapter.inputEvents.map((record) => record.surfaceId)).toEqual([surfaceId, surfaceId, surfaceId]);
      expect(h.svc.threads.turnRow(cancelled.turnId)?.status).toBe("cancelled");
    } finally {
      adapter.releaseInputs();
    }
  });

  test("Takeover persists one fresh final observation and resumes that same tool call", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Same-turn Takeover Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    adapter.setWindows(surfaceId, [{ id: "window-1", title: "Fresh window", focused: true }]);
    adapter.blockFirstCapture(surfaceId);

    const sent = await sendToBot(h, botId, "computer:screenshot");
    await adapter.waitForBlockedCapture();
    expect(coordination(h, surfaceId)).toMatchObject({ authority_kind: "agent" });
    expect(await waitForTakeover(h, owner, "available")).toMatchObject({
      state: "bot-using",
      takeover: "available",
    });

    const authorityTransition = Promise.withResolvers<void>();
    const subscribedHarness = h;
    const unsubscribeAuthority = h.svc.events.subscribe((event) => {
      if (
        event.aggregateType === "computer"
        && event.aggregateId === surfaceId
        && coordination(subscribedHarness, surfaceId)?.authority_kind === "takeover"
      ) {
        authorityTransition.resolve();
      }
    });
    const takeover = computerRequest(h, owner, "POST", "/api/computer/take-control");
    await authorityTransition.promise.finally(unsubscribeAuthority);
    const beforeQuiescence = await Promise.race([
      takeover.then(() => "takeover-settled" as const),
      computerRequest(h, owner, "GET", "/api/computer/state").then(() => "state-readable" as const),
    ]);
    expect(beforeQuiescence).toBe("state-readable");
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");

    adapter.releaseBlockedCapture();
    const taken = await takeover;
    expect(taken.response.status).toBe(200);
    expect(taken.body).toMatchObject({ state: "user-control", takeover: "active" });
    expect(coordination(h, surfaceId)).toMatchObject({ authority_kind: "takeover" });
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    expect(adapter.captureStarts(surfaceId)).toBe(1);
    expect(adapter.actionsStarted).toBe(0);
    adapter.blockActions();
    const artifactsBeforeReturn = artifactCount(h, surfaceId);
    expect(artifactsBeforeReturn).toBe(0);
    const returning = computerRequest(h, owner, "POST", "/api/computer/return-to-bot");
    await adapter.waitForActions(1);
    const duplicate = await computerRequest(h, owner, "POST", "/api/computer/return-to-bot");
    expect(duplicate.response.status).toBe(409);
    adapter.releaseActions();
    const returned = await returning;
    expect(returned.response.status).toBe(200);
    expect(returned.body).toMatchObject({ takeover: "unavailable" });
    expect(coordination(h, surfaceId)).toMatchObject({ authority_kind: "idle" });
    await waitThreadIdle(h, sent.threadId);

    expect(adapter.captureStarts(surfaceId)).toBe(2);
    expect(adapter.actionsStarted).toBe(1);
    expect(artifactCount(h, surfaceId)).toBe(1);
    const transcript = await messages(h, sent.threadId);
    const computerTools = transcript.filter((message) =>
      message.kind === "tool" && message.toolCall?.name === "computer"
    );
    expect(computerTools).toHaveLength(1);
    expect(transcript.some((message) =>
      message.text?.includes(`"surfaceId":"${surfaceId}"`)
      && message.text.includes("Fresh window")
      && message.text.includes("imageRef")
    )).toBeTrue();
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
  });

  test("persisted authority transitions are isolated by Surface", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const firstBotId = await makeBot(h, "Authority owner");
    const first = { botId: firstBotId, surfaceId: await botSurface(h, firstBotId) };
    const secondBotId = await makeBot(h, "Authority peer");
    const second = { botId: secondBotId, surfaceId: await botSurface(h, secondBotId) };

    await h.svc.computer.agentToolAct(
      second,
      "authority-second-turn",
      "authority-second-tool",
      { name: "observe", args: {} },
      new AbortController().signal,
    );
    const secondSettled = coordination(h, second.surfaceId);
    expect(secondSettled).toMatchObject({ authority_kind: "idle" });

    adapter.blockInputs();
    const controller = new AbortController();
    const firstAction = h.svc.computer.agentToolAct(
      first,
      "authority-first-turn",
      "authority-first-tool",
      { name: "click", args: { x: 4, y: 5 } },
      controller.signal,
    );
    await adapter.waitForInputAttempts(1);
    expect(coordination(h, first.surfaceId)).toMatchObject({ authority_kind: "agent" });
    expect(coordination(h, second.surfaceId)).toEqual(secondSettled);

    const takeover = h.svc.computer.takeOver(first);
    expect(coordination(h, first.surfaceId)).toMatchObject({ authority_kind: "takeover" });
    expect(coordination(h, second.surfaceId)).toEqual(secondSettled);
    adapter.releaseInputs();
    await expect(takeover).resolves.toEqual({ ok: true });
    expect(coordination(h, first.surfaceId)).toMatchObject({ authority_kind: "takeover" });
    expect(coordination(h, second.surfaceId)).toEqual(secondSettled);

    controller.abort(new Error("authority isolation complete"));
    await expect(firstAction).rejects.toThrow("authority isolation complete");
    expect(coordination(h, first.surfaceId)).toMatchObject({ authority_kind: "idle" });
    expect(coordination(h, second.surfaceId)).toEqual(secondSettled);
  });

  test("Takeover is unavailable without a pending Broker tool and native cancellation cancels a held waiter", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Cancelled Takeover Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };

    const unavailable = await computerRequest(h, owner, "POST", "/api/computer/take-control");
    expect(unavailable.response.status).toBe(409);
    expect(unavailable.body).toEqual({ error: "Takeover requires a pending computer tool." });

    adapter.blockInputs();
    const sent = await sendToBot(h, botId, "computer:click:cancelled-takeover");
    await adapter.waitForInputAttempts(1);
    const takeover = computerRequest(h, owner, "POST", "/api/computer/take-control");
    expect(await Promise.race([
      takeover.then(() => "takeover-settled" as const),
      computerRequest(h, owner, "GET", "/api/computer/state").then(() => "state-readable" as const),
    ])).toBe("state-readable");
    adapter.releaseInputs();
    expect((await takeover).body).toMatchObject({ takeover: "active" });

    await h.svc.turns.abortTurn(sent.turnId, "cancel held Takeover");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("cancelled");
    expect(await waitForTakeover(h, owner, "unavailable")).toMatchObject({
      takeover: "unavailable",
    });
    const returned = await computerRequest(h, owner, "POST", "/api/computer/return-to-bot");
    expect(returned.response.status).toBe(409);
    expect(adapter.inputEvents.map((record) => record.surfaceId)).toEqual([surfaceId, surfaceId, surfaceId]);
  });

  test("Agent-worker loss during a held Takeover fails the turn and never reconstructs the waiter", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Restarted Takeover Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    adapter.blockInputs();

    const sent = await sendToBot(h, botId, "computer:click:worker-restart");
    await adapter.waitForInputAttempts(1);
    const takeover = computerRequest(h, owner, "POST", "/api/computer/take-control");
    expect(await Promise.race([
      takeover.then(() => "takeover-settled" as const),
      computerRequest(h, owner, "GET", "/api/computer/state").then(() => "state-readable" as const),
    ])).toBe("state-readable");
    adapter.releaseInputs();
    expect((await takeover).body).toMatchObject({ takeover: "active" });

    await expect(
      h.svc.turns.send(botId, sent.threadId, "crash-agent"),
    ).rejects.toThrow("steer unavailable");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("failed");
    expect(await waitForTakeover(h, owner, "unavailable")).toMatchObject({
      takeover: "unavailable",
    });
    expect(adapter.inputEvents.map((record) => record.surfaceId)).toEqual([surfaceId, surfaceId, surfaceId]);
    const transcript = await messages(h, sent.threadId);
    expect(transcript.some((message) =>
      message.author.kind === "system" && message.text?.includes("worker exited")
    )).toBeTrue();
  });

  test("daemon restart fails a held Takeover turn instead of pretending to resume it", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Daemon restart Takeover Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    adapter.blockInputs();

    const sent = await sendToBot(h, botId, "computer:click:daemon-restart");
    await adapter.waitForInputAttempts(1);
    const takeover = computerRequest(h, owner, "POST", "/api/computer/take-control");
    expect(await Promise.race([
      takeover.then(() => "takeover-settled" as const),
      computerRequest(h, owner, "GET", "/api/computer/state").then(() => "state-readable" as const),
    ])).toBe("state-readable");
    adapter.releaseInputs();
    expect((await takeover).body).toMatchObject({ takeover: "active" });
    const staleAuthority = coordination(h, surfaceId);
    expect(staleAuthority).toMatchObject({ authority_kind: "takeover" });

    const home = h.home;
    await h.stop();
    const staleDb = new Database(path.join(home, "db.sqlite"));
    staleDb
      .query(
        `UPDATE computer_surface_coordination
         SET authority_kind = 'web', updated_at = ? WHERE surface_id = ?`,
      )
      .run(new Date(0).toISOString(), surfaceId);
    staleDb.close();
    h = await startDaemon(home, { botScreenAdapter: new FakeBotScreenRuntimeAdapter() });
    expect(coordination(h, surfaceId)).toEqual({
      authority_kind: "idle",
    });
    const turn = h.svc.threads.turnRow(sent.turnId);
    expect(turn?.status).toBe("failed");
    expect(turn?.outcome_reason).toMatch(/daemon (?:stopped|restart)/);
    expect(await waitForTakeover(h, owner, "unavailable")).toMatchObject({
      takeover: "unavailable",
    });
  });

  test("every stale or mismatched binding identity fails without touching either Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const firstBot = await makeBot(h, "Context owner Bot");
    const secondBot = await makeBot(h, "Context other Bot");
    const secondSurface = await botSurface(h, secondBot);
    const runningHarness = h;

    const turns = await Promise.all([
      sendToBot(h, firstBot, `computer:observe:mismatch:${secondSurface}`),
      sendToBot(h, firstBot, "computer:observe:stale"),
      sendToBot(h, firstBot, "computer:observe:wrong-bot"),
      sendToBot(h, firstBot, "computer:observe:wrong-session"),
      sendToBot(h, firstBot, "computer:observe:missing-tool-call"),
    ]);
    await Promise.all(turns.map((turn) => waitThreadIdle(runningHarness, turn.threadId)));

    expect(adapter.actionsStarted).toBe(0);
    for (const turn of turns) {
      const row = h.svc.threads.turnRow(turn.turnId);
      expect(row?.status).toBe("failed");
      expect(row?.outcome_reason).toContain("computer tool context");
    }
  }, 15_000);

  test("Agent worker loss fails its active tool turn instead of reconstructing or rerouting it", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const bot = await makeBot(h, "Crashed Agent worker Bot");

    const sent = await sendToBot(h, bot, "computer:crash-agent");
    await waitThreadIdle(h, sent.threadId);

    expect(adapter.actionsStarted).toBe(0);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("failed");
    expect(h.svc.threads.turnRow(sent.turnId)?.outcome_reason).toContain("worker exited");
  }, 15_000);

  test("assigned worker failure fails honestly and never reroutes", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const bot = await makeBot(h, "Failed tool Bot");
    const surfaceId = await botSurface(h, bot);

    adapter.failNextCapture(surfaceId);
    const sent = await sendToBot(h, bot, "computer:observe");
    await waitThreadIdle(h, sent.threadId);

    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("failed");
    expect(h.svc.threads.turnRow(sent.turnId)?.outcome_reason).toContain("fake Bot Screen capture failed");
  }, 15_000);
});
