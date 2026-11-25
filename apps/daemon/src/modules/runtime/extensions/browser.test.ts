import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { AGENT_BROWSER_TOOL, BROWSER_TOOL_SCHEMA, type AgentBrowserToolOutput } from "@omarchy-bot/agent-contract";
import type { SurfaceId } from "@omarchy-bot/domain";
import type { ComputerBroker } from "../../computer/broker.ts";
import { createBrowserExtension } from "./browser.ts";

type BrokerAction = ComputerBroker["agentBrowserAct"];
const owner = { botId: "bot-1", surfaceId: "surf_test" as SurfaceId };
const desktopSession = { ...owner, runtimeGeneration: 2 };

async function withTurn(
  agentBrowserAct: BrokerAction,
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
      modelTool = getCurrentTools(messages).find((tool) => tool.name === "browser");
      systemPrompt = getCurrentSystemPrompt(messages);
      return fauxAssistantMessage([fauxToolCall("browser", args, { id: "browser-1" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Finished"),
  ]);
  const registry = createRegistry();
  const storage = new MemoryStorage();
  registry.install(createBrowserExtension({
    broker: { agentBrowserAct },
    async owner() { return { ...owner, turnId: "turn-1" }; },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }));
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, context);
    const submission = await conversation.submit({ type: "input", content: "Use the browser", requestId: "turn-1" }, context);
    const waiting = submission.wait(context);
    await options.duringTurn?.(conversation);
    const settlement = await waiting;
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const entry = items.find(ToolResultEntry.is);
    const result = entry?.model?.find((message) => message.role === "toolResult");
    return { settlement, result, diagnostics: entry?.data.diagnostics, modelTool, systemPrompt };
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
}

function hangingBroker() {
  const started = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let running = false;
  const act: BrokerAction = async (_owner, _turnId, _callId, _action, requestSignal) => {
    signal = requestSignal;
    running = true;
    const result = Promise.withResolvers<AgentBrowserToolOutput>();
    const abort = () => result.reject(requestSignal.reason);
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
  return { act, started: started.promise, state: () => ({ signal, running }) };
}

test("browser dispatches the Harness identity and returns the worker's text-only result and details", async () => {
  const args = { url: "https://example.test/path?next=https://example.test/dest" };
  const details = { desktopSession, text: "Page loaded" };
  const calls: Parameters<BrokerAction>[] = [];
  const { settlement, result, modelTool, systemPrompt } = await withTurn(async (...request) => {
    calls.push(request);
    return details;
  }, { action: "navigate", args });
  expect(calls).toEqual([[owner, "turn-1", "browser-1", { name: "navigate", args }, expect.any(AbortSignal)]]);
  expect(modelTool).toMatchObject({ name: AGENT_BROWSER_TOOL.name, description: AGENT_BROWSER_TOOL.description, parameters: BROWSER_TOOL_SCHEMA });
  expect(systemPrompt).toContain(AGENT_BROWSER_TOOL.systemPrompt.summary);
  for (const guideline of AGENT_BROWSER_TOOL.systemPrompt.guidelines) expect(systemPrompt).toContain(guideline);
  expect(settlement.status).toBe("done");
  expect(result?.isError).toBe(false);
  expect(result?.content).toEqual([{ type: "text", text: `Bot Desktop Session: ${JSON.stringify(desktopSession)}\nPage loaded` }]);
  expect(result?.details).toEqual(details);
});

test("browser preserves broker text and appends the worker's truncation notice only for a truncated result", async () => {
  const text = "Page text ".repeat(6_000);
  const details = { desktopSession, text, truncated: true };
  const { result, diagnostics } = await withTurn(async () => details, { action: "read_text" });
  expect(diagnostics).toEqual([]);
  expect(result?.content).toEqual([{
    type: "text", text: `Bot Desktop Session: ${JSON.stringify(desktopSession)}\n${text}\nBrowser result truncated; some content is omitted.`,
  }]);
  expect(result?.details).toEqual(details);
});

test("browser defaults missing args and returns a bare broker error with empty details", async () => {
  const calls: Parameters<BrokerAction>[] = [];
  const { settlement, result } = await withTurn(async (...request) => {
    calls.push(request);
    throw new Error("Browser unavailable");
  }, { action: "snapshot" });
  expect(calls).toEqual([[owner, "turn-1", "browser-1", { name: "snapshot", args: {} }, expect.any(AbortSignal)]]);
  expect(settlement.status).toBe("done");
  expect(result?.isError).toBe(true);
  expect(result?.content).toEqual([{ type: "text", text: "Browser unavailable" }]);
  expect(result?.details).toEqual({});
});

test("browser times out and cancels a hanging broker call", async () => {
  const broker = hangingBroker();
  const { settlement, result } = await withTurn(broker.act, { action: "snapshot" }, { timeoutMs: 20 });
  const message = "browser tool timed out after 20 ms";
  expect(settlement.status).toBe("done");
  expect(result?.isError).toBe(true);
  expect(result?.content).toEqual([{ type: "text", text: message }]);
  expect(result?.details).toEqual({});
  expect(broker.state()).toMatchObject({ signal: { aborted: true, reason: { message } }, running: false });
});

test("aborting a Harness turn aborts its in-flight browser broker request", async () => {
  const broker = hangingBroker();
  const { settlement, result } = await withTurn(broker.act, { action: "snapshot" }, {
    duringTurn: async (conversation) => {
      await broker.started;
      await conversation.abort(context);
    },
  });
  expect(settlement).toMatchObject({ status: "unanswered", reason: "aborted" });
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/aborted/i) }] });
  expect(broker.state()).toMatchObject({ signal: { aborted: true, reason: { message: "browser tool call aborted" } }, running: false });
});
