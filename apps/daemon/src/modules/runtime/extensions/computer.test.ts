import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { AGENT_COMPUTER_TOOL, COMPUTER_TOOL_SCHEMA, type AgentComputerToolOutput } from "@omarchy-bot/agent-contract";
import type { SurfaceId } from "@omarchy-bot/domain";
import type { ComputerBroker } from "../../computer/broker.ts";
import { createComputerExtension } from "./computer.ts";
import { awaitWithSignal } from "../../computer/awaitWithSignal.ts";

type BrokerAction = ComputerBroker["agentToolAct"];
const owner = { botId: "bot-1", surfaceId: "surf_test" as SurfaceId };
const desktopSession = { ...owner, runtimeGeneration: 2 };

async function withTurn(
  agentToolAct: BrokerAction,
  args: Parameters<typeof fauxToolCall>[1],
  options: { timeoutMs?: number; duringTurn?: (conversation: Conversation) => Promise<void> } = {},
) {
  const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(provider.provider);
  let modelTool: ReturnType<typeof getCurrentTools>[number] | undefined;
  let systemPrompt = "";
  provider.setResponses([
    ({ messages }) => {
      modelTool = getCurrentTools(messages).find((tool) => tool.name === "computer");
      systemPrompt = getCurrentSystemPrompt(messages);
      return fauxAssistantMessage([fauxToolCall("computer", args, { id: "computer-1" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Finished"),
  ]);
  const registry = createRegistry();
  const storage = new MemoryStorage();
  const bindings: { conversationId: number; turnId: string }[] = [];
  registry.install(createComputerExtension({
    broker: { agentToolAct },
    async owner({ conversationId }) {
      bindings.push({ conversationId, turnId: "turn-1" });
      return { ...owner, turnId: "turn-1" };
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }));
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, context);
    const submission = await conversation.submit({ type: "input", content: "Use the computer", requestId: "turn-1" }, context);
    const waiting = submission.wait(context);
    await options.duringTurn?.(conversation);
    const settlement = await waiting;
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const entry = items.find(ToolResultEntry.is);
    const result = entry?.model?.find((message) => message.role === "toolResult");
    return { settlement, result, diagnostics: entry?.data.diagnostics, modelTool, systemPrompt, bindings, conversationId: conversation.id };
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
}

function hangingBroker() {
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let abortReason: unknown;
  let running = false;
  const act: BrokerAction = async (_owner, _turnId, _callId, _action, requestSignal) => {
    signal = requestSignal;
    running = true;
    const result = Promise.withResolvers<AgentComputerToolOutput>();
    const abort = () => {
      abortReason = requestSignal.reason;
      result.reject(abortReason);
    };
    requestSignal.addEventListener("abort", abort, { once: true });
    started.resolve();
    try {
      requestSignal.throwIfAborted();
      return await result.promise;
    } finally {
      requestSignal.removeEventListener("abort", abort);
      running = false;
    }
  };
  return { act, started: started.promise, state: () => ({ signal, abortReason, running }) };
}

test("computer dispatches the Harness identity and returns the worker's text, image, and details", async () => {
  const details = { desktopSession, text: "Screen observed", imageRef: "artifact-1", windowList: [{ id: "window-1", title: "Test window" }] };
  const calls: Parameters<BrokerAction>[] = [];
  const { settlement, result, modelTool, systemPrompt, bindings, conversationId } = await withTurn(async (...request) => {
    calls.push(request);
    return {
      ...details,
      inlineImage: { type: "image", mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") },
      imageFile: { mediaType: "image/png", path: "/unused/worker-snapshot.png" },
    };
  }, { action: "observe", args: { custom: true } });
  expect(bindings).toEqual([{ conversationId, turnId: "turn-1" }]);
  expect(calls).toEqual([[owner, "turn-1", "computer-1", { name: "observe", args: { custom: true } }, expect.any(AbortSignal)]]);
  expect(modelTool).toMatchObject({ name: AGENT_COMPUTER_TOOL.name, description: AGENT_COMPUTER_TOOL.description, parameters: COMPUTER_TOOL_SCHEMA });
  expect(systemPrompt).toContain(AGENT_COMPUTER_TOOL.systemPrompt.summary);
  for (const guideline of AGENT_COMPUTER_TOOL.systemPrompt.guidelines) expect(systemPrompt).toContain(guideline);
  expect(settlement.status).toBe("done");
  expect(result).toMatchObject({
    isError: false,
    content: [
      { type: "text", text: `Bot Desktop Session: ${JSON.stringify(desktopSession)}\nScreen observed\nBot Screen snapshot artifact: artifact-1\nWindows: ${JSON.stringify(details.windowList)}` },
      { type: "image", mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") },
    ],
  });
  expect(result?.details).toEqual(details);
});

test("computer defaults missing args and returns worker-shaped broker errors", async () => {
  const calls: Parameters<BrokerAction>[] = [];
  const { settlement, result } = await withTurn(async (...request) => {
    calls.push(request);
    throw new Error("Screen capture failed");
  }, { action: "screenshot" });
  expect(calls).toEqual([[owner, "turn-1", "computer-1", { name: "screenshot", args: {} }, expect.any(AbortSignal)]]);
  expect(settlement.status).toBe("done");
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Screen capture failed") }] });
  expect(result?.content).toEqual([{ type: "text", text: "Screen capture failed" }]);
  expect(result?.details).toEqual({});
});

test("computer preserves a window list larger than the Harness output limit without a diagnostic", async () => {
  const windowList = Array.from({ length: 500 }, (_, id) => ({ id, title: "Window ".repeat(20) }));
  const { result, diagnostics } = await withTurn(async () => ({ desktopSession, windowList }), { action: "list_windows" });
  const text = `Bot Desktop Session: ${JSON.stringify(desktopSession)}\nWindows: ${JSON.stringify(windowList)}`;
  expect(Buffer.byteLength(text)).toBeGreaterThan(50 * 1024);
  expect(diagnostics).toEqual([]);
  expect(result?.content).toEqual([{ type: "text", text }]);
  expect(result?.details).toEqual({ desktopSession, windowList });
});

test("an already-aborted signal wins over settled shared work", async () => {
  const reason = new Error("stale request");
  const signal = AbortSignal.abort(reason);
  await expect(awaitWithSignal(Promise.resolve("available"), signal)).rejects.toBe(reason);
  await expect(awaitWithSignal(Promise.reject(new Error("shared failure")), signal)).rejects.toBe(reason);
});

test("computer times out and cancels a hanging broker call", async () => {
  const broker = hangingBroker();
  const { settlement, result } = await withTurn(broker.act, { action: "observe" }, { timeoutMs: 20 });
  expect(settlement.status).toBe("done");
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("computer tool timed out after 20 ms") }] });
  expect(broker.state()).toMatchObject({ signal: { aborted: true }, abortReason: { message: "computer tool timed out after 20 ms" }, running: false });
});

test("aborting a Harness turn aborts its in-flight computer broker request", async () => {
  const broker = hangingBroker();
  const { settlement, result } = await withTurn(broker.act, { action: "observe" }, {
    duringTurn: async (conversation) => {
      await broker.started;
      await conversation.abort(context);
    },
  });
  expect(settlement).toMatchObject({ status: "unanswered", reason: "aborted" });
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/aborted/i) }] });
  expect(broker.state()).toMatchObject({ signal: { aborted: true }, abortReason: { message: "computer tool call aborted" }, running: false });
});
