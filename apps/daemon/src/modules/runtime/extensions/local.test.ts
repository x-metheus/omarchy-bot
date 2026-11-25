import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { DeviceServerFrameSchema, type DeviceLocalJobFrame, type DeviceServerFrame } from "@omarchy-bot/protocol";
import { SidecarBroker } from "../../devices/sidecarBroker.ts";
import type { RuntimeServices } from "../runtime.ts";
import { createLocalExtension } from "./local.ts";
import { DispatchedCallIds } from "./model-call.ts";

const deviceId = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const job = { action: "run", command: "echo local" } as const;
type Broker = RuntimeServices["sidecars"];

async function runLocalCall(options: {
  sidecars?: Broker;
  args?: ToolCall["arguments"];
  callRounds?: ToolCall[][];
  deadlineMs?: number;
  duringCall?: (conversation: Conversation) => Promise<void>;
}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    ...(options.callRounds ?? [[fauxToolCall("local", options.args ?? job, { id: "local-call" })]])
      .map((calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" })),
    fauxAssistantMessage("Finished"),
  ]);
  const db = new Database(":memory:");
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const active = new Map([
    ["turn-active", { inputs: new Set<number>(), deviceId }],
    ["turn-follow-up", { inputs: new Set<number>(), deviceId: "other-device" }],
  ]);
  registry.install(createLocalExtension(db, () => options.sidecars, active, new DispatchedCallIds(), options.deadlineMs));
  const models = createModels();
  models.setProvider(fake.provider);
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "fake", modelId: "fake-model" } } }, context);
    db.exec(`
      CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT, bot_id TEXT, status TEXT);
      CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER);
      INSERT INTO turns VALUES ('turn-active', 'thread-active', 'bot-local', 'working');
      INSERT INTO turns VALUES ('turn-follow-up', 'thread-active', 'bot-local', 'working');
    `);
    db.run("INSERT INTO pi_thread_conversations VALUES ('thread-active', 'bot-local', ?)", [conversation.id]);
    const submission = await conversation.submit({ type: "input", content: "Run the local tool", requestId: "turn-active" }, context);
    active.get("turn-active")!.inputs.add(submission.id);
    await options.duringCall?.(conversation);
    const settlement = await submission.wait(context);
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const results = items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? []);
    return { settlement, results };
  } finally {
    await harness.close(context);
    await storage.close(context);
    db.close();
  }
}

function recordingBroker(text = "local output") {
  const output = { deviceId, hostname: "laptop", text, exitCode: 0 };
  const calls: Parameters<Broker["execute"]>[] = [];
  const sidecars: Broker = { async execute(...args) { calls.push(args); return output; } };
  return { sidecars, calls, output };
}

function pendingBroker(workspace = "/unused") {
  const broker = new SidecarBroker(workspace);
  const frames: DeviceServerFrame[] = [];
  const started = Promise.withResolvers<DeviceLocalJobFrame>();
  const port = {
    send(frame: DeviceServerFrame) {
      frames.push(frame);
      if (frame.type === "local.job") started.resolve(frame);
    },
    close() {},
  };
  const registered = broker.register(port, {
    type: "register", deviceId, hostname: "laptop", os: "linux", shell: "posix-sh", capabilities: ["shell", "transfer"],
  });
  expect(registered.ok).toBeTrue();
  return { broker, port, frames, started: started.promise };
}

test("local dispatches with the active Turn and its originating device and returns text and details", async () => {
  const { sidecars, calls, output } = recordingBroker();
  const { settlement, results } = await runLocalCall({ sidecars });
  expect(settlement.status).toBe("done");
  expect(calls.map(([args, owner, signal]) => [args, owner, signal])).toEqual([
    [job, { botId: "bot-local", turnId: "turn-active", deviceId }, expect.any(AbortSignal)],
  ]);
  expect(results).toMatchObject([{ role: "toolResult", toolName: "local", isError: false, content: [{ type: "text", text: output.text }], details: output }]);
});

test("local rejects both calls with the same ID in one assistant response", async () => {
  const { sidecars, calls } = recordingBroker();
  const { settlement, results } = await runLocalCall({ sidecars, callRounds: [[
    fauxToolCall("local", job, { id: "duplicate-call" }),
    fauxToolCall("local", { action: "run", command: "echo other" }, { id: "duplicate-call" }),
  ]] });
  expect(settlement.status).toBe("done");
  expect(calls).toEqual([]);
  const error = {
    toolCallId: "duplicate-call", isError: true,
    content: [{ type: "text", text: expect.stringContaining('duplicate tool call ID "duplicate-call" in the assistant response') }],
  };
  expect(results).toMatchObject([error, error]);
});

test("local rejects a dispatched call ID reused in a later assistant response of the same Turn", async () => {
  const { sidecars, calls } = recordingBroker();
  const { settlement, results } = await runLocalCall({ sidecars, callRounds: [
    [fauxToolCall("local", job, { id: "reused-call" })],
    [fauxToolCall("local", { action: "run", command: "echo other" }, { id: "reused-call" })],
  ] });
  expect(settlement.status).toBe("done");
  expect(calls.map(([args]) => args)).toEqual([job]);
  expect(results).toMatchObject([
    { toolCallId: "reused-call", isError: false },
    { toolCallId: "reused-call", isError: true, content: [{ type: "text", text: expect.stringContaining("tool call was already dispatched") }] },
  ]);
});

test("local preserves valid multiline output in the committed tool result", async () => {
  const text = "界\n".repeat(4_096);
  const { sidecars } = recordingBroker(text);
  const { settlement, results } = await runLocalCall({ sidecars });
  expect(settlement.status).toBe("done");
  expect(results[0]?.content).toEqual([{ type: "text", text }]);
});

test.each(["botId", "turnId"])("local rejects caller-supplied %s before dispatch", async (field) => {
  const { sidecars, calls } = recordingBroker();
  const { results } = await runLocalCall({ sidecars, args: { ...job, [field]: "forged" } });
  expect(calls).toEqual([]);
  expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining('Validation failed for tool "local"') }] }]);
});

test("aborting the live run cancels a pending local job", async () => {
  const { broker, frames, started } = pendingBroker();
  try {
    const { settlement } = await runLocalCall({ sidecars: broker, async duringCall(conversation) {
      await started;
      await conversation.abort(context);
    } });
    expect(settlement).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(frames).toEqual([await started, { type: "local.cancel", jobId: (await started).jobId }]);
  } finally { broker.close(); }
});

test("the local deadline cancels a pending job and returns a timeout error", async () => {
  const { broker, frames, started } = pendingBroker();
  try {
    const { results } = await runLocalCall({ sidecars: broker, deadlineMs: 100 });
    const [dispatched] = frames;
    if (dispatched?.type !== "local.job") throw new Error("No local job was dispatched before the deadline");
    expect(frames).toEqual([await started, { type: "local.cancel", jobId: dispatched.jobId }]);
    expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining("local timed out") }] }]);
  } finally { broker.close(); }
});

test("a deadline expiring during frame validation reports timeout without dispatch or an unhandled rejection", async () => {
  const { broker, frames } = pendingBroker();
  const deadlineMs = 100;
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const parse = DeviceServerFrameSchema.safeParse.bind(DeviceServerFrameSchema);
  let jobValidations = 0;
  const validation = spyOn(DeviceServerFrameSchema, "safeParse").mockImplementation((frame, options) => {
    const result = parse(frame, options);
    if (result.success && result.data.type === "local.job") {
      jobValidations++;
      now += deadlineMs;
    }
    return result;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { results } = await runLocalCall({ sidecars: broker, deadlineMs });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(jobValidations).toBe(1);
    expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining("local timed out") }] }]);
    expect(frames).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    validation.mockRestore();
    clock.mockRestore();
    broker.close();
  }
});

test("a workspace transfer times out while its source read is held and never dispatches late", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omarchy-local-transfer-"));
  const source = join(workspace, "source.txt");
  writeFileSync(source, "payload");
  const { broker, frames } = pendingBroker(workspace);
  const release = Promise.withResolvers<string>();
  const finished = Promise.withResolvers<void>();
  const fileSystem: { readFile(path: string, options: { encoding: "utf8"; signal: AbortSignal }): Promise<string> } = fs;
  const readFile = fileSystem.readFile;
  const heldRead = spyOn(fileSystem, "readFile").mockImplementation((path, options) =>
    path === source ? release.promise : readFile(path, options));
  try {
    const { settlement, results } = await runLocalCall({
      sidecars: { execute: (...args) => broker.execute(...args).finally(finished.resolve) },
      args: { action: "transfer", direction: "from-workspace", path: "source.txt", destination: "incoming.txt" },
      deadlineMs: 100,
    });
    expect(settlement.status).toBe("done");
    expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining("local timed out") }] }]);
    expect(frames).toEqual([]);
    expect(heldRead.mock.calls.some(([path]) => path === source)).toBeTrue();
    release.resolve("payload");
    await finished.promise;
    expect(frames).toEqual([]);
  } finally {
    release.resolve("payload");
    heldRead.mockRestore();
    broker.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}, 1_000);

test("a workspace write completed after the local deadline leaves the destination unchanged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "omarchy-local-transfer-"));
  const destination = join(workspace, "destination.txt");
  writeFileSync(destination, "original");
  const { broker, port, frames, started } = pendingBroker(workspace);
  const release = Promise.withResolvers<void>();
  let writeCompleted = false;
  let brokerWork: ReturnType<Broker["execute"]> | undefined;
  const writeFile = fs.writeFile;
  const delayedWrite = spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
    await writeFile(path, data, options);
    writeCompleted = true;
    await release.promise;
  });
  try {
    const { settlement, results } = await runLocalCall({
      sidecars: { execute: (...args) => {
        brokerWork = broker.execute(...args);
        return brokerWork;
      } },
      args: { action: "transfer", direction: "to-workspace", path: "source.txt", destination: "destination.txt" },
      deadlineMs: 250,
      async duringCall() {
        const dispatched = await started;
        broker.complete(port, deviceId, { type: "local.result", jobId: dispatched.jobId, ok: true, text: "payload" });
      },
    });
    expect(settlement.status).toBe("done");
    expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining("local timed out") }] }]);
    expect(frames).toEqual([await started]);
    expect(writeCompleted).toBeTrue();
    expect(readFileSync(destination, "utf8")).toBe("original");

    release.resolve();
    await expect(brokerWork!).rejects.toThrow("local timed out");
    expect(readFileSync(destination, "utf8")).toBe("original");
    expect(readdirSync(workspace)).toEqual(["destination.txt"]);
  } finally {
    release.resolve();
    delayedWrite.mockRestore();
    broker.close();
    await brokerWork?.catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});

test.each(["success", "failure"])("a workspace rename pending through the deadline reports its actual %s", async (outcome) => {
  const workspace = mkdtempSync(join(tmpdir(), "omarchy-local-transfer-"));
  const destination = join(workspace, "destination.txt");
  writeFileSync(destination, "original");
  const { broker, port, started } = pendingBroker(workspace);
  const renameStarted = Promise.withResolvers<void>();
  const deadlineReached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let brokerWork: ReturnType<Broker["execute"]> | undefined;
  const rename = fs.rename;
  const heldRename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    renameStarted.resolve();
    await release.promise;
    if (outcome === "failure") throw new Error("workspace rename failed");
    await rename(from, to);
  });
  try {
    const { settlement, results } = await runLocalCall({
      sidecars: { execute: (...args) => {
        args[2].addEventListener("abort", () => deadlineReached.resolve(), { once: true });
        brokerWork = broker.execute(...args);
        return brokerWork;
      } },
      args: { action: "transfer", direction: "to-workspace", path: "source.txt", destination: "destination.txt" },
      deadlineMs: 250,
      async duringCall() {
        const dispatched = await started;
        broker.complete(port, deviceId, { type: "local.result", jobId: dispatched.jobId, ok: true, text: "payload" });
        await renameStarted.promise;
        await deadlineReached.promise;
        release.resolve();
      },
    });
    await brokerWork?.catch(() => {});
    expect(settlement.status).toBe("done");
    const succeeded = outcome === "success";
    expect(readFileSync(destination, "utf8")).toBe(succeeded ? "payload" : "original");
    expect(readdirSync(workspace)).toEqual(["destination.txt"]);
    expect(results).toMatchObject([{
      isError: !succeeded,
      content: [{ type: "text", text: succeeded ? "payload" : expect.stringContaining("workspace rename failed") }],
    }]);
  } finally {
    release.resolve();
    heldRename.mockRestore();
    broker.close();
    await brokerWork?.catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("local fails clearly before the Sidecar broker is bound", async () => {
  const { results } = await runLocalCall({});
  expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: expect.stringContaining("Sidecar broker is not bound") }] }]);
});
