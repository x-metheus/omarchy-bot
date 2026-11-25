import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ToolResultEntry, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { AgentPluginToolOutput } from "@omarchy-bot/agent-contract";
import type { PluginsService } from "../../plugins/plugins.ts";
import type { RuntimeServices } from "../runtime.ts";
import { createLocalExtension } from "./local.ts";
import { DispatchedCallIds } from "./model-call.ts";
import { createPluginsExtension } from "./plugins.ts";

type PluginToolService = Pick<PluginsService, "callManage">;
const args = { action: "inspect_skill", id: "catalog.invalid/example" };
const image = { type: "image", data: "AQID", mimeType: "image/png" } as const;
const output: AgentPluginToolOutput = {
  content: [{ type: "text", text: "界\n".repeat(15_000) }, image, { type: "text", text: "after the image" }],
  structuredContent: { skill: { name: "example" } },
};

async function runManageCall(options: {
  plugins?: PluginToolService;
  sidecars?: RuntimeServices["sidecars"];
  arguments?: ToolCall["arguments"];
  callRounds?: ToolCall[][];
  bindingBot?: string;
  deadlineMs?: number;
  beforeExecute?: (context: Context) => Context;
  duringCall?: (conversation: Conversation) => Promise<void>;
}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    ...(options.callRounds ?? [[fauxToolCall("manage_plugins", options.arguments ?? args, { id: "plugin-call" })]])
      .map((calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" })),
    fauxAssistantMessage("Finished"),
  ]);
  const db = new Database(":memory:");
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const active = new Map([["turn-active", { inputs: new Set<number>() }]]);
  const dispatched = new DispatchedCallIds();
  if (options.sidecars) registry.install(createLocalExtension(db, () => options.sidecars, active, dispatched));
  const extension = createPluginsExtension(db, () => options.plugins, active, dispatched, options.deadlineMs);
  const tool = extension.tools![0]!;
  registry.install({ ...extension, tools: [{
    ...tool,
    execute(args: Parameters<typeof tool.execute>[0], api: ToolExecutionApi, context: Context) {
      return tool.execute(args, api, options.beforeExecute?.(context) ?? context);
    },
  }] });
  const models = createModels();
  models.setProvider(fake.provider);
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "fake", modelId: "fake-model" } } }, context);
    db.exec(`
      CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT, bot_id TEXT, status TEXT);
      CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER);
      INSERT INTO turns VALUES ('turn-active', 'thread-active', 'bot-active', 'working');
    `);
    db.run("INSERT INTO pi_thread_conversations VALUES ('thread-active', ?, ?)", [options.bindingBot ?? "bot-active", conversation.id]);
    const submission = await conversation.submit({ type: "input", content: "Manage plugins", requestId: "turn-active" }, context);
    active.get("turn-active")!.inputs.add(submission.id);
    await options.duringCall?.(conversation);
    const settlement = await submission.wait(context);
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const results = items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult");
    return { settlement, results };
  } finally {
    await harness.close(context);
    await storage.close(context);
    db.close();
  }
}

function recordingPlugins(callManage: PluginToolService["callManage"] = async () => output) {
  const calls: Parameters<PluginToolService["callManage"]>[] = [];
  const plugins: PluginToolService = { callManage(...args) { calls.push(args); return callManage(...args); } };
  return { plugins, calls };
}

function pendingPlugins() {
  const started = Promise.withResolvers<AbortSignal>();
  const recording = recordingPlugins(async (_name, _args, signal) => {
    started.resolve(signal);
    // An action may not observe cancellation. The runtime still must settle the wait.
    return new Promise<AgentPluginToolOutput>(() => {});
  });
  return { ...recording, started: started.promise };
}

function toolError(text: string) {
  return { isError: true, content: [{ type: "text", text: expect.stringContaining(text) }] };
}

test("manage_plugins dispatches from the active Turn and preserves content and details", async () => {
  const { plugins, calls } = recordingPlugins();
  const { settlement, results } = await runManageCall({ plugins });
  expect(settlement.status).toBe("done");
  expect(calls).toEqual([["manage_plugins", args, expect.any(AbortSignal)]]);
  expect(results).toMatchObject([{ toolName: "manage_plugins", isError: false, content: output.content, details: output.structuredContent }]);
});

test("manage_plugins refuses to dispatch when the active Turn and conversation identities disagree", async () => {
  const { plugins, calls } = recordingPlugins();
  const { results } = await runManageCall({ plugins, bindingBot: "bot-other" });
  expect(calls).toEqual([]);
  expect(results).toMatchObject([toolError("Service Turn does not match the conversation's Thread and Bot")]);
});

test.each(["botId", "threadId", "turnId"])("manage_plugins rejects caller-supplied %s", async (field) => {
  const { plugins, calls } = recordingPlugins();
  const { results } = await runManageCall({ plugins, arguments: { ...args, [field]: "forged" } });
  expect(calls).toEqual([]);
  expect(results).toMatchObject([toolError('Validation failed for tool "manage_plugins"')]);
});

test("manage_plugins rejects calls to connected-service tools as an action", async () => {
  const { plugins, calls } = recordingPlugins();
  const { results } = await runManageCall({ plugins, arguments: { action: "call" } });
  expect(calls).toEqual([]);
  expect(results).toMatchObject([toolError('Validation failed for tool "manage_plugins"')]);
});

test("manage_plugins rejects duplicate IDs in an assistant response", async () => {
  const { plugins, calls } = recordingPlugins();
  const call = fauxToolCall("manage_plugins", args, { id: "plugin-call" });
  const { results } = await runManageCall({ plugins, callRounds: [[call, call]] });
  expect(calls).toEqual([]);
  const error = toolError('duplicate tool call ID "plugin-call" in the assistant response');
  expect(results).toMatchObject([error, error]);
});

test("manage_plugins rejects a dispatched call ID reused in a later assistant response of the same Turn", async () => {
  const { plugins, calls } = recordingPlugins();
  const { settlement, results } = await runManageCall({ plugins, callRounds: [
    [fauxToolCall("manage_plugins", args, { id: "reused-call" })],
    [fauxToolCall("manage_plugins", { action: "list" }, { id: "reused-call" })],
  ] });
  expect(settlement.status).toBe("done");
  expect(calls).toEqual([["manage_plugins", args, expect.any(AbortSignal)]]);
  expect(results).toMatchObject([
    { toolName: "manage_plugins", toolCallId: "reused-call", isError: false },
    { toolName: "manage_plugins", toolCallId: "reused-call", ...toolError("tool call was already dispatched") },
  ]);
});

test("local rejects a call ID dispatched by manage_plugins and accepts a fresh ID in the same Turn", async () => {
  const { plugins, calls } = recordingPlugins();
  const localCalls: Parameters<RuntimeServices["sidecars"]["execute"]>[0][] = [];
  const sidecars: RuntimeServices["sidecars"] = { async execute(args) {
    localCalls.push(args);
    return { deviceId: "device-local", hostname: "laptop", text: "local output", exitCode: 0 };
  } };
  const localJob = { action: "run", command: "echo local" } as const;
  const { settlement, results } = await runManageCall({ plugins, sidecars, callRounds: [
    [fauxToolCall("manage_plugins", args, { id: "plugin-call" })],
    [
      fauxToolCall("local", { action: "run", command: "echo duplicate" }, { id: "plugin-call" }),
      fauxToolCall("local", localJob, { id: "local-call" }),
    ],
  ] });
  expect(settlement.status).toBe("done");
  expect(calls).toHaveLength(1);
  expect(localCalls).toEqual([localJob]);
  expect(results).toMatchObject([
    { toolName: "manage_plugins", toolCallId: "plugin-call", isError: false },
    { toolName: "local", toolCallId: "plugin-call", ...toolError("tool call was already dispatched") },
    { toolName: "local", toolCallId: "local-call", isError: false },
  ]);
});
test("manage_plugins throws joined error text and uses the worker fallback for an image-only error", async () => {
  const parts = [{ type: "text", text: "first error" }, image, { type: "text", text: "second error" }] as const;
  const { plugins } = recordingPlugins(async () => ({ isError: true, content: [...parts], structuredContent: { omitted: true } }));
  const { results } = await runManageCall({ plugins });
  expect(results).toMatchObject([toolError("first error\nsecond error")]);
  expect(results[0]?.details).toBeUndefined();
  const imageOnly = recordingPlugins(async () => ({ isError: true, content: [image] }));
  const fallback = await runManageCall({ plugins: imageOnly.plugins });
  expect(fallback.results).toMatchObject([toolError("Remote plugin tool returned an error")]);
});

test("manage_plugins does not dispatch if its invocation is already aborted", async () => {
  const { plugins, calls } = recordingPlugins();
  const signal = AbortSignal.abort(new Error("cancelled before plugin dispatch"));
  const { results } = await runManageCall({ plugins, beforeExecute: (context) => withAbortSignal(signal, context) });
  expect(calls).toEqual([]);
  expect(results).toMatchObject([toolError("cancelled before plugin dispatch")]);
});

test("aborting the live run cancels a pending manage_plugins wait and its forwarded signal", async () => {
  const { plugins, started } = pendingPlugins();
  const { settlement } = await runManageCall({ plugins, async duringCall(conversation) {
    await started;
    await conversation.abort(context);
  } });
  expect(settlement).toMatchObject({ status: "unanswered", reason: "aborted" });
  expect((await started).aborted).toBeTrue();
});

test("the manage_plugins deadline returns a timeout and aborts the forwarded signal", async () => {
  const { plugins, calls } = pendingPlugins();
  const { results } = await runManageCall({ plugins, deadlineMs: 100 });
  expect(results).toMatchObject([toolError("manage_plugins timed out")]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[2].reason).toMatchObject({ name: "TimeoutError" });
});

test("manage_plugins fails clearly before PluginsService is bound", async () => {
  const { results } = await runManageCall({});
  expect(results).toMatchObject([toolError("manage_plugins: Plugins service is not bound")]);
});
