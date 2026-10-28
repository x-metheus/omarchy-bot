import { afterEach, describe, expect, test } from "bun:test";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import type { SurfaceId } from "../../packages/domain/src/index.ts";
import type { ComputerViewDto } from "../../packages/protocol/src/index.ts";
import { api, authedFetch, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { until } from "./helpers/bot-screen-load-observe.ts";

async function owner(h: Harness, botId: string): Promise<{ botId: string; surfaceId: SurfaceId }> {
  const bot = await api<{ surfaceId: SurfaceId }>(h, "GET", `/api/bots/${botId}`);
  return { botId, surfaceId: bot.surfaceId };
}

async function computer(h: Harness, binding: { botId: string; surfaceId: SurfaceId }, path: string, method = "GET"): Promise<ComputerViewDto> {
  const query = new URLSearchParams(binding);
  const response = await authedFetch(h, `${h.baseUrl}/api/computer/${path}?${query}`, { method });
  expect(response.status).toBe(200);
  return response.json();
}

describe("Bot-bound Agent browser tool", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("a scripted public Agent turn invokes browser with JSON args on its own Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Browser owner");
    const binding = await owner(h, botId);
    const other = await owner(h, await makeBot(h, "Browser peer"));
    const url = "https://example.test/form?next=https://example.test/done";

    const sent = await sendToBot(h, botId, `browser:navigate:${JSON.stringify({ url })}`);
    await waitThreadIdle(h, sent.threadId);

    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
    expect(adapter.browserActions).toContainEqual({ surfaceId: binding.surfaceId, action: { name: "navigate", args: { url } } });
    expect(h.svc.screens.status(other)).toEqual({ state: "stopped" });
    const transcript = await messages(h, sent.threadId);
    expect(transcript.some((message) => message.kind === "tool" && message.toolCall?.name === "browser")).toBeTrue();
    expect(transcript.some((message) => message.text?.includes(binding.surfaceId))).toBeTrue();
  });

  test("rejects every stale or mismatched binding before touching either Screen", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Browser binding owner");
    const binding = await owner(h, botId);
    const other = await owner(h, await makeBot(h, "Browser binding peer"));
    const running = h;
    const turns = await Promise.all([
      sendToBot(h, botId, `browser:snapshot:mismatch:${other.surfaceId}`),
      sendToBot(h, botId, "browser:snapshot:stale"),
      sendToBot(h, botId, "browser:snapshot:wrong-bot"),
      sendToBot(h, botId, "browser:snapshot:wrong-session"),
      sendToBot(h, botId, "browser:snapshot:missing-tool-call"),
    ]);
    await Promise.all(turns.map((turn) => waitThreadIdle(running, turn.threadId)));

    expect(adapter.browserActions).toEqual([]);
    expect(h.svc.screens.status(binding)).toEqual({ state: "stopped" });
    expect(h.svc.screens.status(other)).toEqual({ state: "stopped" });
    for (const [index, turn] of turns.entries()) {
      expect(h.svc.threads.turnRow(turn.turnId)).toMatchObject({
        status: "failed",
        outcome_reason: index === 4 ? "tool call has not started" : "browser tool context is stale or mismatched",
      });
    }
  }, 15_000);

  test("an Agent takeover request shows its reason and holds the invocation until I'm done", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Browser login owner");
    const binding = await owner(h, botId);
    const reason = "Please complete the login: use your account";
    const sent = await sendToBot(h, botId, `browser:request_takeover:${JSON.stringify({ reason })}`);
    const running = h;
    const needed = await until(async () => {
      const state = await computer(running, binding, "state");
      return state.state === "needs-you" ? state : undefined;
    }, 5_000, "browser did not request human Takeover");

    expect(needed.takeoverReason).toBe(reason);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "response")).toBeFalse();
    const taken = await computer(h, binding, "take-control", "POST");
    expect(taken).toMatchObject({ takeover: "active", takeoverReason: reason });
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    await computer(h, binding, "return-to-bot", "POST");
    await waitThreadIdle(h, sent.threadId);

    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
    const transcript = await messages(h, sent.threadId);
    expect(transcript.filter((message) => message.kind === "tool" && message.toolCall?.name === "browser")).toHaveLength(1);
    expect(transcript.some((message) => message.text?.includes(binding.surfaceId) && message.text.includes("desktopSession"))).toBeTrue();
    expect(transcript.some((message) => message.text?.includes('[e1-1] textbox Name'))).toBeTrue();
    expect(adapter.browserActions.some((record) => record.action.name === "snapshot")).toBeTrue();
    expect((await computer(h, binding, "state")).takeoverReason).toBeUndefined();
  }, 10_000);

  test("user Takeover holds a pending browser action and returns a fresh snapshot through the same tool", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Browser interrupted owner");
    const binding = await owner(h, botId);
    adapter.blockActions();
    try {
      const sent = await sendToBot(h, botId, "browser:snapshot");
      await adapter.waitForActions(1);
      const taking = computer(h, binding, "take-control", "POST");
      expect(await Promise.race([
        taking.then(() => "takeover-settled"),
        computer(h, binding, "state").then(() => "state-readable"),
      ])).toBe("state-readable");
      adapter.releaseActions();
      expect(await taking).toMatchObject({ state: "user-control" });
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
      await computer(h, binding, "return-to-bot", "POST");
      await waitThreadIdle(h, sent.threadId);

      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      expect(adapter.browserActions.filter((record) => record.action.name === "snapshot")).toHaveLength(2);
      const transcript = await messages(h, sent.threadId);
      expect(transcript.filter((message) => message.kind === "tool" && message.toolCall?.name === "browser")).toHaveLength(1);
      expect(transcript.some((message) => message.text?.includes('[e1-2] textbox Name'))).toBeTrue();
    } finally {
      adapter.releaseActions();
    }
  });

  test("cancelling a browser invocation held by user Takeover ends the same tool", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Cancelled browser interruption");
    const binding = await owner(h, botId);
    adapter.blockActions();
    try {
      const sent = await sendToBot(h, botId, "browser:snapshot");
      await adapter.waitForActions(1);
      const taking = computer(h, binding, "take-control", "POST");
      expect(await Promise.race([
        taking.then(() => "takeover-settled"),
        computer(h, binding, "state").then(() => "state-readable"),
      ])).toBe("state-readable");
      adapter.releaseActions();
      expect(await taking).toMatchObject({ takeover: "active" });
      await h.svc.turns.abortTurn(sent.turnId, "cancel held browser invocation");
      await waitThreadIdle(h, sent.threadId);

      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("cancelled");
      expect(await computer(h, binding, "state")).toMatchObject({ takeover: "unavailable" });
      expect(adapter.browserActions.filter((record) => record.action.name === "snapshot")).toHaveLength(1);
      expect((await messages(h, sent.threadId)).some((message) => message.kind === "response")).toBeFalse();
    } finally {
      adapter.releaseActions();
    }
  });

  test("cancelling an Agent-requested Takeover clears the reason without delivering a snapshot", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Cancelled browser login");
    const binding = await owner(h, botId);
    const sent = await sendToBot(h, botId, 'browser:request_takeover:{"reason":"Please complete the CAPTCHA"}');
    const running = h;
    await until(async () => {
      const state = await computer(running, binding, "state");
      return state.takeoverReason === "Please complete the CAPTCHA" && state.takeover === "active" ? true : undefined;
    }, 5_000, "browser Takeover was not held");

    await h.svc.turns.abortTurn(sent.turnId, "cancel requested browser Takeover");
    await waitThreadIdle(h, sent.threadId);

    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("cancelled");
    expect(await computer(h, binding, "state")).toMatchObject({ takeover: "unavailable" });
    expect((await computer(h, binding, "state")).takeoverReason).toBeUndefined();
    expect(adapter.browserActions).toEqual([]);
    const response = await authedFetch(h, `${h.baseUrl}/api/computer/return-to-bot?${new URLSearchParams(binding)}`, { method: "POST" });
    expect(response.status).toBe(409);
  }, 10_000);

  test("request_takeover refuses Screen capacity before holding the invocation", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter, botScreenCapacity: 1 });
    const first = await owner(h, await makeBot(h, "Capacity occupant"));
    const refused = await owner(h, await makeBot(h, "Capacity refused"));
    expect(await h.svc.screens.ensureReady(first)).toBe(true);
    const call = h.svc.computer.agentBrowserAct(refused, "capacity-turn", "capacity-tool", { name: "request_takeover", args: { reason: "Please log in" } }, AbortSignal.timeout(200));
    await expect(call).rejects.toThrow("Bot Screen");
    expect(h.svc.computer.state(refused).takeover).toBe("unavailable");
    expect(h.svc.computer.state(refused).takeoverReason).toBeUndefined();
    expect(adapter.browserActions).toEqual([]);
  });

  test("request_takeover rejects unavailable host browser before holding", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: {
      start: async provision => {
        const runtime = await adapter.start(provision);
        return { ...runtime, browser: async () => { throw new Error("Browser tool unavailable: the host browser has no owned CDP pipe. Use the pack browser or computer tools."); } };
      },
    } });
    const binding = await owner(h, await makeBot(h, "Host browser unavailable"));
    const call = h.svc.computer.agentBrowserAct(binding, "host-turn", "host-tool", { name: "request_takeover", args: { reason: "Please log in" } }, AbortSignal.timeout(200));
    await expect(call).rejects.toThrow("host browser has no owned CDP pipe. Use the pack browser or computer tools.");
    expect(h.svc.computer.state(binding).takeover).toBe("unavailable");
    expect(h.svc.computer.state(binding).takeoverReason).toBeUndefined();
    expect(adapter.inputEvents).toEqual([]);
  });

  test("cancelling a queued browser call rejects before the held Takeover finishes", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Queued browser cancellation");
    const binding = await owner(h, botId);
    const reason = "Please finish the login";
    const sent = await sendToBot(h, botId, `browser:request_takeover:${JSON.stringify({ reason })}`);
    const running = h;
    await until(async () => {
      const state = await computer(running, binding, "state");
      return state.takeoverReason === reason && state.takeover === "active" ? true : undefined;
    }, 5_000, "first browser invocation was not held");

    const controller = new AbortController();
    const queued = h.svc.computer.agentBrowserAct(
      binding,
      "queued-browser-turn",
      "queued-browser-tool",
      { name: "snapshot", args: {} },
      controller.signal,
    ).then(() => "completed" as const, (error: unknown) => error);
    controller.abort(new Error("cancel queued browser action"));
    try {
      const result = await Promise.race([
        queued,
        computer(h, binding, "state").then(() => "still queued" as const),
      ]);
      expect(result).toBeInstanceOf(Error);
      expect(result instanceof Error ? result.message : result).toBe("cancel queued browser action");
      expect(await computer(h, binding, "state")).toMatchObject({ takeover: "active", takeoverReason: reason });
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
      expect(adapter.browserActions).toEqual([]);
    } finally {
      await computer(h, binding, "return-to-bot", "POST");
      await queued;
      await waitThreadIdle(h, sent.threadId);
    }
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
    expect(adapter.browserActions).toEqual([{ surfaceId: binding.surfaceId, action: { name: "snapshot", args: {} } }]);
    expect(adapter.inputEvents).toEqual([]);
  }, 10_000);

  test("browser and computer calls on one Screen stay ordered through the Broker", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Ordered browser owner");
    const binding = await owner(h, botId);
    adapter.blockActions();
    try {
      const browser = await sendToBot(h, botId, "browser:snapshot");
      await adapter.waitForActions(1);
      const observing = await sendToBot(h, botId, "computer:observe");
      expect(h.svc.threads.turnRow(observing.turnId)?.status).toBe("working");
      expect(adapter.captureStarts(binding.surfaceId)).toBe(0);
      expect(adapter.actionsStarted).toBe(1);
      adapter.releaseActions();
      await Promise.all([waitThreadIdle(h, browser.threadId), waitThreadIdle(h, observing.threadId)]);

      expect(h.svc.threads.turnRow(browser.turnId)?.status).toBe("completed");
      expect(h.svc.threads.turnRow(observing.turnId)?.status).toBe("completed");
      expect(adapter.captureStarts(binding.surfaceId)).toBe(1);
    } finally {
      adapter.releaseActions();
    }
  });

  test("scripted browser ref input uses the owning Screen and stale refs fail before input", async () => {
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const botId = await makeBot(h, "Browser form owner");
    const binding = await owner(h, botId);
    const snapshot = await sendToBot(h, botId, "browser:snapshot");
    await waitThreadIdle(h, snapshot.threadId);
    const typed = await sendToBot(h, botId, 'browser:type:{"ref":"e1-1","text":"Ada: Lovelace"}');
    await waitThreadIdle(h, typed.threadId);

    expect(h.svc.threads.turnRow(typed.turnId)?.status).toBe("completed");
    expect(adapter.browserActions).toContainEqual({ surfaceId: binding.surfaceId, action: { name: "type", args: { ref: "e1-1", text: "Ada: Lovelace" } } });
    expect(adapter.inputEvents.length).toBeGreaterThan(0);
    expect(adapter.inputEvents.every((record) => record.surfaceId === binding.surfaceId)).toBeTrue();
    const inputs = adapter.inputEvents.length;
    const refreshed = await sendToBot(h, botId, "browser:snapshot");
    await waitThreadIdle(h, refreshed.threadId);
    const stale = await sendToBot(h, botId, 'browser:click:{"ref":"e1-1"}');
    await waitThreadIdle(h, stale.threadId);

    expect(h.svc.threads.turnRow(stale.turnId)).toMatchObject({
      status: "failed",
      outcome_reason: "Stale Element Ref e1-1; take a new snapshot before acting.",
    });
    expect(adapter.inputEvents).toHaveLength(inputs);
  });
});
