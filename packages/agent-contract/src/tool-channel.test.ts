import { describe, expect, test } from "bun:test";
import { createToolChannelDaemon, createToolChannelWorker, type ToolChannelFrame } from "./tool-channel.ts";

const context = {
  botId: "bot_0123456789abcdef0123456789abcdef",
  turnId: "turn_0123456789abcdef0123456789abcdef",
  toolCallId: "call-1",
};

const echo = {
  name: "echo",
  schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
};

function request(requestId: string, params: unknown, toolCallId = context.toolCallId): ToolChannelFrame {
  return { type: "tool.request", requestId, name: "echo", params, context: { ...context, toolCallId } };
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

  test("rejects a second dispatch of a tool call that already ran", async () => {
    const daemon = createToolChannelDaemon({
      tools: [echo],
      execute: () => ({ value: 1 }),
    });
    daemon.start(context.toolCallId);
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
    daemon.start(context.toolCallId);
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
    daemon.start(context.toolCallId);
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
    daemon.start(context.toolCallId);
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
});
