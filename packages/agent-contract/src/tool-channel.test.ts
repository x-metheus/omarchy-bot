import { describe, expect, test } from "bun:test";
import { createToolChannelDaemon, createToolChannelWorker, type ToolChannelFrame } from "./tool-channel.ts";

const context = {
  botId: "bot_0123456789abcdef0123456789abcdef",
  turnId: "turn_0123456789abcdef0123456789abcdef",
  toolCallId: "call-1",
  workerSessionId: "s_session",
};

const echo = {
  name: "echo",
  schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
};

function request(requestId: string, params: unknown, toolCallId = context.toolCallId, name = "echo"): ToolChannelFrame {
  return { type: "tool.request", requestId, name, params, context: { ...context, toolCallId } };
}

describe("ToolChannel", () => {
  test("rejects a request for a tool call the turn has not started", async () => {
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: () => ({ ok: true }),
    });
    const result = await daemon.receive(request("req-1", { n: 1 }));
    expect(result).toEqual({ type: "tool.result", requestId: "req-1", ok: false, error: "tool call has not started" });
  });

  test("rejects a request whose tool name differs from the one that started the call", async () => {
    let runs = 0;
    const daemon = createToolChannelDaemon({
      tools: [echo, { name: "send_bot_message", schema: { type: "object", properties: { text: { type: "string" } } } }],
      execute: () => {
        runs += 1;
        return { ok: true };
      },
    });
    daemon.start(context.toolCallId, "echo");
    const result = await daemon.receive(request("req-1", { text: "hi" }, context.toolCallId, "send_bot_message"));
    expect(result).toEqual({ type: "tool.result", requestId: "req-1", ok: false, error: "tool request does not match the started tool call" });
    expect(runs).toBe(0);
  });

  test("rejects a second dispatch of a tool call that already ran", async () => {
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: () => ({ value: 1 }),
    });
    daemon.start(context.toolCallId, "echo");
    expect(await daemon.receive(request("req-1", { n: 1 }))).toMatchObject({ ok: true });
    const again = await daemon.receive(request("req-2", { n: 1 }));
    expect(again).toEqual({ type: "tool.result", requestId: "req-2", ok: false, error: "tool call was already dispatched" });
  });

  test("rejects a replayed request id without running the tool again", async () => {
    let runs = 0;
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: () => {
        runs += 1;
        return { value: 1 };
      },
    });
    daemon.start(context.toolCallId, "echo");
    await daemon.receive(request("req-1", { n: 1 }));
    const replay = await daemon.receive(request("req-1", { n: 1 }));
    expect(replay).toEqual({ type: "tool.result", requestId: "req-1", ok: false, error: "duplicate tool request" });
    expect(runs).toBe(1);
  });

  test("rejects params the tool schema does not accept and does not run it", async () => {
    let runs = 0;
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: () => {
        runs += 1;
        return {};
      },
    });
    daemon.start(context.toolCallId, "echo");
    const result = await daemon.receive(request("req-1", { n: "x" }));
    expect(result).toEqual({ type: "tool.result", requestId: "req-1", ok: false, error: "tool params do not match echo" });
    expect(runs).toBe(0);
  });

  test("aborts the executor signal when the turn aborts", async () => {
    const worker = createToolChannelWorker();
    const turn = new AbortController();
    let executorSignal: AbortSignal | undefined;
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: (_params, _context, signal) => new Promise((_resolve, reject) => {
        executorSignal = signal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    daemon.start(context.toolCallId, "echo");
    worker.send = (frame) => { void daemon.receive(frame).then((result) => worker.receive(result)); };
    const pending = worker.call("echo", { n: 1 }, context, turn.signal);
    turn.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(executorSignal?.aborted).toBeTrue();
  });

  test("rejects a pending worker call when the session closes", async () => {
    const worker = createToolChannelWorker();
    const pending = worker.call("echo", { n: 1 }, context, new AbortController().signal);
    worker.close();
    await expect(pending).rejects.toThrow("tool session closed");
  });

  test("close only rejects the pending calls of the given worker session", async () => {
    const worker = createToolChannelWorker();
    const sent: ToolChannelFrame[] = [];
    worker.send = (frame) => sent.push(frame);
    const other = { ...context, workerSessionId: "s_other" };
    const closing = worker.call("echo", { n: 1 }, context, new AbortController().signal);
    const surviving = worker.call("echo", { n: 2 }, other, new AbortController().signal);
    worker.close(context.workerSessionId);
    await expect(closing).rejects.toThrow("tool session closed");
    worker.receive({
      type: "tool.result",
      requestId: (sent[1] as Extract<ToolChannelFrame, { type: "tool.request" }>).requestId,
      ok: true,
      result: { n: 2 },
    });
    expect(await surviving).toEqual({ n: 2 });
  });

  test("aborts a pending call immediately and ignores its late result", async () => {
    const worker = createToolChannelWorker();
    const sent: ToolChannelFrame[] = [];
    worker.send = (frame) => sent.push(frame);
    const turn = new AbortController();
    const pending = worker.call("echo", { n: 1 }, context, turn.signal);
    const request = sent[0] as Extract<ToolChannelFrame, { type: "tool.request" }>;
    turn.abort();
    expect(sent[1]).toEqual({ type: "tool.cancel", requestId: request.requestId });
    await expect(pending).rejects.toThrow("tool call aborted");
    worker.receive({ type: "tool.result", requestId: request.requestId, ok: true, result: { late: true } });
    expect(await pending.then(() => "resolved", (error: Error) => error.message)).toBe("tool call aborted");
    expect(sent).toHaveLength(2);
  });

  test("rejects a call whose signal already aborted without dispatching it", async () => {
    const worker = createToolChannelWorker();
    const sent: ToolChannelFrame[] = [];
    worker.send = (frame) => sent.push(frame);
    const turn = new AbortController();
    turn.abort();
    await expect(worker.call("echo", { n: 1 }, context, turn.signal)).rejects.toThrow("tool call aborted");
    expect(sent).toEqual([]);
  });

  test("close aborts a running executor the dead worker can no longer cancel", async () => {
    const worker = createToolChannelWorker();
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: (_params, _context, signal) => {
        const gate = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => gate.reject(new Error("worker exited")), { once: true });
        return gate.promise;
      },
    });
    daemon.start(context.toolCallId, "echo");
    worker.send = (frame) => { void daemon.receive(frame).then((result) => worker.receive(result)); };
    const pending = worker.call("echo", { n: 1 }, context, new AbortController().signal);
    daemon.close();
    await expect(pending).rejects.toThrow("worker exited");
  });
});
