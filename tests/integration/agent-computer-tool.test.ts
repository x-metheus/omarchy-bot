import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import type { SurfaceId } from "../../packages/domain/src/index.ts";
import type { MessageDto } from "../../packages/protocol/src/index.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { BotScreenInputRejectedError } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import { ScreenInputLease } from "../../apps/daemon/src/modules/computer/screenInputLease.ts";
import { durableSuiteToolResults } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { api, authedFetch, makeBot, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
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
  const response = await authedFetch(h, `${h.baseUrl}${path}?${query}`, { method });
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

describe("Bot-bound computer tool", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("the model receives the actual desktop generation after a computer restart without changing conversation binding", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const harness = h;
    const botId = await makeBot(h, "Desktop identity Bot");
    const surfaceId = await botSurface(h, botId);
    const otherBotId = await makeBot(h, "Unobserved Bot");
    const otherSurfaceId = await botSurface(h, otherBotId);
    const owner = { botId, surfaceId };

    expect(h.svc.screens.status(owner)).toEqual({ state: "stopped" });
    const sent = await sendToBot(h, botId, "computer:observe");
    const { threadId } = sent;
    const binding = h.svc.db.query<{ conversation_id: number }, [string]>(
      "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
    );
    async function latestResult(turnId: string, expectedCount: number) {
      await waitThreadIdle(harness, threadId);
      expect(harness.svc.threads.turnRow(turnId)?.status).toBe("completed");
      const results = (await durableSuiteToolResults(harness.svc.db, threadId))
        .filter((entry) => entry.role === "toolResult" && entry.toolName === "computer");
      expect(results).toHaveLength(expectedCount);
      const result = results.at(-1);
      if (result?.role !== "toolResult") throw new Error("Missing durable computer tool result");
      expect(result.isError).toBeFalse();
      return result;
    }
    async function runComputer(action: "observe" | "click", expectedCount: number) {
      const { turnId } = await sendToThread(harness, threadId, `computer:${action}`);
      return latestResult(turnId, expectedCount);
    }
    const first = await latestResult(sent.turnId, 1);
    const initialBinding = binding.get(threadId);
    expect(initialBinding?.conversation_id).toEqual(expect.any(Number));
    expect(first.details).toHaveProperty("desktopSession", { ...owner, runtimeGeneration: 1 });
    const firstText = first.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(firstText).toContain(JSON.stringify({ ...owner, runtimeGeneration: 1 }));
    expect(firstText).not.toContain(otherSurfaceId);
    expect(first.content.some((item) => item.type === "image")).toBeTrue();

    // A real click on the first runtime proves the input authority of generation 1.
    const firstClick = await runComputer("click", 2);
    expect(firstClick.details).toHaveProperty("desktopSession", { ...owner, runtimeGeneration: 1 });
    expect(adapter.inputEvents.filter((event) => event.runtimeGeneration === 1)).toHaveLength(3);

    // Only a new Bot Computer advances the generation the tool reports.
    adapter.exitCompositor(surfaceId);
    await until(
      () => adapter.running(surfaceId) === undefined ? true : undefined,
      5_000,
      "failed Screen runtime was not cleaned",
    );
    const second = await runComputer("observe", 3);
    expect(second.details).toHaveProperty("desktopSession", { ...owner, runtimeGeneration: 2 });
    const secondText = second.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(secondText).toContain(JSON.stringify({ ...owner, runtimeGeneration: 2 }));
    expect(secondText).not.toContain(otherSurfaceId);
    expect(second.content.some((item) => item.type === "image")).toBeTrue();

    // A real click on the replacement runtime must get its own input authority.
    const secondClick = await runComputer("click", 4);
    expect(secondClick.details).toHaveProperty("desktopSession", { ...owner, runtimeGeneration: 2 });
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

    expect(binding.get(threadId)).toEqual(initialBinding);
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

  test("an aborted input queued behind a snapshot never writes to the Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Queued input Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    const { computer, screens } = h.svc;
    const controller = new AbortController();
    const captured = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const sourceFor = screens.projectionSource.bind(screens);
    let snapshot: ReturnType<typeof computer.snapshot> | undefined;
    adapter.blockFirstCapture(surfaceId);
    const sourceSpy = spyOn(screens, "projectionSource").mockImplementation(async (...args) => {
      const source = await sourceFor(...args);
      if (!source) return source;
      return { ...source, async input(...input) {
        snapshot = computer.snapshot(owner);
        await adapter.waitForBlockedCapture();
        const writing = source.input(...input);
        queued.resolve();
        return writing;
      } };
    });
    const action = computer.agentToolAct(owner, "queued-input", "queued-input-call", { name: "click", args: { x: 3, y: 4 } }, controller.signal);
    const settled = action.catch((error: unknown) => error).finally(captured.resolve);
    try {
      await Promise.race([queued.promise, captured.promise]);
      controller.abort(new Error("cancel queued Screen input"));
      adapter.releaseBlockedCapture();
      expect(await settled).toMatchObject({ message: "cancel queued Screen input" });
      expect(adapter.inputEvents).toHaveLength(0);
    } finally {
      sourceSpy.mockRestore();
      adapter.releaseBlockedCapture();
      await snapshot;
      await settled;
    }
  });

  test("aborting a queued button press releases authority for the next Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Queued press Bot");
    const owner = { botId, surfaceId: await botSurface(h, botId) };
    const peerId = await makeBot(h, "Next press Bot");
    const peer = { botId: peerId, surfaceId: await botSurface(h, peerId) };
    const { computer, screens } = h.svc;
    const controller = new AbortController();
    const queued = Promise.withResolvers<void>();
    const sourceFor = screens.projectionSource.bind(screens);
    let snapshot: ReturnType<typeof computer.snapshot> | undefined;
    const releases: string[] = [];
    let rejectedReleases = 0;
    const captureStarted = Promise.withResolvers<void>();
    const rescueCapture = new AbortController();
    const start = adapter.start.bind(adapter);
    const startSpy = spyOn(adapter, "start").mockImplementation(async (provision) => {
      const runtime = await start(provision);
      const capture = runtime.capture.bind(runtime);
      runtime.capture = (signal) => capture(signal ?? rescueCapture.signal);
      return runtime;
    });
    adapter.stallNextCaptures(owner.surfaceId, 1);
    adapter.onCaptureSpawn((surfaceId) => { if (surfaceId === owner.surfaceId) captureStarted.resolve(); });
    const sourceSpy = spyOn(screens, "projectionSource").mockImplementation(async (...args) => {
      const source = await sourceFor(...args);
      if (!source) return source;
      return { ...source, async input(event, signal) {
        if (args[0].surfaceId === owner.surfaceId && event.type === "button") {
          if (event.state === "released") {
            rejectedReleases++;
            throw new Error("helper rejected release of an unacknowledged button");
          }
          snapshot = computer.snapshot(owner);
          await captureStarted.promise;
          const writing = source.input(event, signal);
          queued.resolve();
          return writing;
        }
        await source.input(event, signal);
      }, async releaseInput(epoch) {
        releases.push(args[0].surfaceId);
        await source.releaseInput(epoch);
      } };
    });
    const click = { name: "click", args: { x: 3, y: 4 } } as const;
    const first = computer.agentToolAct(owner, "press", "press-call", click, controller.signal).catch((error: unknown) => error);
    try {
      await Promise.race([queued.promise, first.then(() => { throw new Error("press did not queue"); })]);
      expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(1);
      controller.abort(new Error("queued press cancelled"));
      const settled = await Promise.race([first, Bun.sleep(7_000).then(() => undefined)]);
      expect(settled).toMatchObject({ message: "queued press cancelled" });
      expect(adapter.captureAborts(owner.surfaceId)).toBe(1);
      expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(0);
      expect(await snapshot).toBeUndefined();
      expect(releases).toEqual([owner.surfaceId]);
      expect(rejectedReleases).toBe(0);
      await computer.agentToolAct(peer, "peer-press", "peer-press-call", click, AbortSignal.timeout(2_000));
      expect(adapter.inputEvents.map(({ surfaceId, event }) => [surfaceId, event.type])).toEqual([
        [owner.surfaceId, "motion"], [peer.surfaceId, "motion"], [peer.surfaceId, "button"], [peer.surfaceId, "button"],
      ]);
      expect(await computer.snapshot(owner)).toMatchObject({ mediaType: "image/png", bytes: expect.any(Uint8Array) });
    } finally {
      sourceSpy.mockRestore();
      startSpy.mockRestore();
      rescueCapture.abort();
      await snapshot;
      await first;
    }
  }, 12_000);

  test("a rejected synthetic release still releases Screen authority and lets a peer type", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Acknowledged press Bot");
    const owner = { botId, surfaceId: await botSurface(h, botId) };
    const peerId = await makeBot(h, "Peer typing Bot");
    const peer = { botId: peerId, surfaceId: await botSurface(h, peerId) };
    const { computer, screens } = h.svc;
    const controller = new AbortController();
    const reason = new Error("acknowledged press cancelled");
    const releaseError = new BotScreenInputRejectedError("helper rejected synthetic release");
    const sourceFor = screens.projectionSource.bind(screens);
    const cleanup: string[] = [];
    const sourceSpy = spyOn(screens, "projectionSource").mockImplementation(async (...args) => {
      const source = await sourceFor(...args);
      if (!source || args[0].surfaceId !== owner.surfaceId) return source;
      return { ...source, async input(event, signal) {
        if (event.type === "button" && event.state === "released" && signal === undefined) {
          cleanup.push("synthetic release rejected");
          throw releaseError;
        }
        await source.input(event, signal);
        if (event.type === "button" && event.state === "pressed") controller.abort(reason);
      }, async releaseInput(epoch) {
        await source.releaseInput(epoch);
        cleanup.push("authority released");
      } };
    });
    try {
      const action = computer.agentToolAct(owner, "pressed", "pressed-call", { name: "click", args: { x: 3, y: 4 } }, controller.signal);
      await expect(action).rejects.toBe(releaseError);
      expect(adapter.inputEvents.some(({ surfaceId, event }) => surfaceId === owner.surfaceId && event.type === "button" && event.state === "pressed")).toBe(true);
      expect(cleanup).toEqual(["synthetic release rejected", "authority released"]);
      await computer.agentToolAct(peer, "peer-type", "peer-type-call", { name: "type", args: { text: "peer" } }, AbortSignal.timeout(2_000));
      expect(adapter.inputEvents.at(-1)).toMatchObject({ surfaceId: peer.surfaceId, event: { type: "paste", text: "peer" } });
    } finally { sourceSpy.mockRestore(); }
  });

  test("aborting a grant queued behind a snapshot settles Takeover and frees the seat", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Queued grant Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    const peerId = await makeBot(h, "Peer input Bot");
    const peer = { botId: peerId, surfaceId: await botSurface(h, peerId) };
    const { computer, screens } = h.svc;
    await screens.ensureReady(owner);
    adapter.blockFirstCapture(surfaceId);
    const snapshot = computer.snapshot(owner);
    const controller = new AbortController();
    let action: Promise<unknown> | undefined;
    let takeover: Promise<unknown> | undefined;
    const grantQueued = Promise.withResolvers<void>();
    const sourceFor = screens.projectionSource.bind(screens);
    const sourceSpy = spyOn(screens, "projectionSource").mockImplementation((...args) => {
      if (args[0].surfaceId === surfaceId) grantQueued.resolve();
      return sourceFor(...args);
    });
    try {
      await adapter.waitForBlockedCapture();
      action = computer.agentToolAct(owner, "queued-grant", "queued-grant-call", { name: "click", args: { x: 3, y: 4 } }, controller.signal).catch((error: unknown) => error);
      await grantQueued.promise;
      takeover = computer.takeOver(owner);
      controller.abort(new Error("cancel queued Screen grant"));
      const next = computer.agentToolAct(peer, "peer-grant", "peer-grant-call", { name: "click", args: { x: 3, y: 4 } }, AbortSignal.timeout(2_000));
      const settled = await Promise.race([Promise.all([action, takeover, next]), Bun.sleep(1_500).then(() => undefined)]);
      expect(settled?.[0]).toMatchObject({ message: "cancel queued Screen grant" });
      expect(settled?.[1]).toEqual({ ok: false });
      expect(adapter.inputEvents.map((input) => input.surfaceId)).toEqual([peer.surfaceId, peer.surfaceId, peer.surfaceId]);
      expect(computer.state(owner).lastImageAt).toBeUndefined();
    } finally {
      sourceSpy.mockRestore();
      adapter.releaseBlockedCapture();
      await Promise.all([snapshot, action, takeover]);
    }
  });

  test("a screenshot publishes idle before its image and abort before publication leaves no artifact", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Screenshot publication Bot");
    const surfaceId = await botSurface(h, botId);
    const owner = { botId, surfaceId };
    const harness = h;
    const controller = new AbortController();
    const events: Array<{ authority: string | undefined; image: string | undefined }> = [];
    let abortBeforePublication = true;
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (event.aggregateType !== "computer" || event.aggregateId !== surfaceId) return;
      const authority = coordination(harness, surfaceId)?.authority_kind;
      const image = harness.svc.computer.state(owner).lastImageAt;
      events.push({ authority, image });
      if (abortBeforePublication && authority === "idle") controller.abort(new Error("cancel before screenshot publication"));
    });
    try {
      await expect(h.svc.computer.agentToolAct(owner, "aborted-shot", "aborted-call", { name: "screenshot", args: {} }, controller.signal)).rejects.toThrow("cancel before screenshot publication");
      expect(artifactCount(h, surfaceId)).toBe(0);
      expect(h.svc.computer.state(owner).lastImageAt).toBeUndefined();
      abortBeforePublication = false;
      events.length = 0;
      const shot = await h.svc.computer.agentToolAct(owner, "successful-shot", "successful-call", { name: "screenshot", args: {} }, new AbortController().signal, true);
      const artifact = h.svc.db.query<{ path: string }, [string]>("SELECT path FROM artifacts WHERE id = ?").get(shot.imageRef!);
      expect(shot.inlineImage).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from(await Bun.file(artifact!.path).arrayBuffer()).toString("base64") });
      expect(shot.imageFile).toBeUndefined();
      const idle = events.filter(({ authority }) => authority === "idle");
      expect(idle[0]?.image).toBeUndefined();
      expect(idle.at(-1)?.image).toEqual(expect.any(String));
      expect(artifactCount(h, surfaceId)).toBe(1);
    } finally { unsubscribe(); }
  });

  test.each([false, true])("Web Control claimed at screenshot idle survives tool cleanup (abort=%s)", async (abort) => {
    h = await startDaemon();
    const harness = h;
    const botId = await makeBot(h, "Web Control during screenshot");
    const owner = { botId, surfaceId: await botSurface(h, botId) };
    const controller = new AbortController();
    let lease: ScreenInputLease | undefined;
    const beginAgentTool = ScreenInputLease.prototype.beginAgentTool;
    const leaseSpy = spyOn(ScreenInputLease.prototype, "beginAgentTool").mockImplementation(function (this: ScreenInputLease, ...args) {
      lease = this;
      return beginAgentTool.apply(this, args);
    });
    let claimed = false;
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (claimed || event.aggregateType !== "computer" || event.aggregateId !== owner.surfaceId
        || coordination(harness, owner.surfaceId)?.authority_kind !== "idle") return;
      claimed = true;
      queueMicrotask(() => {
        lease?.webControlClaimed(owner);
        if (abort) controller.abort(new Error("screenshot aborted after Web Control claim"));
      });
    });
    try {
      const shot = h.svc.computer.agentToolAct(owner, "claim", "claim-call", { name: "screenshot", args: {} }, controller.signal);
      if (abort) {
        await expect(shot).rejects.toThrow(/aborted/i);
        expect(artifactCount(h, owner.surfaceId)).toBe(0);
      } else {
        expect((await shot).imageRef).toBeDefined();
      }
      expect(claimed).toBe(true);
      expect(coordination(h, owner.surfaceId)?.authority_kind).toBe("web");
    } finally {
      unsubscribe();
      leaseSpy.mockRestore();
    }
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
    await h.disconnectForRestart();
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

  test("assigned Screen capture failure fails the Turn", async () => {
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
