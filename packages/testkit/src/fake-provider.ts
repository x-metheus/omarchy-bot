import { existsSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export { fauxAssistantMessage, fauxToolCall };

export type FakeSegment = { type: "text" | "thinking"; text: string };
export type FakeReply = { segments: FakeSegment[]; failure?: string } | FauxResponseFactory;

/** A network-free pi-ai provider with scripted responses. */
export function createFakeProvider(replies: FakeReply[], options: { tokensPerSecond?: number } = {}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], ...options, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(replies.map((reply) => {
    if (typeof reply === "function") return reply;
    const content = reply.segments.map((segment) => segment.type === "text" ? fauxText(segment.text) : fauxThinking(segment.text));
    return fauxAssistantMessage(content, reply.failure === undefined ? {} : { stopReason: "error", errorMessage: reply.failure });
  }));
  return fake;
}

const orderedIntro = [
  "## Release notes", "", "1. Preserve **ordered blocks**.", "2. Keep `Steering` in place.", "",
  "| Boundary | Result |", "| --- | --- |", "| Response → Thinking | separate |", "| Tool → Response | separate |", "",
  "```ts", 'const order = ["response", "thinking", "tool", "response"];', "```", "", "Long-form context ".repeat(24).trim(),
].join("\n");

function userTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) => message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")] : []);
}

export const durableSuiteToolCalls = {
  thinking: fauxToolCall("read", { path: "src/input.ts" }, { id: "thinking-tool" }),
  process: fauxToolCall("read", { path: "src/hidden.ts" }, { id: "process-only" }),
  orderedRead: fauxToolCall("read", { path: "src/transcript.ts" }, { id: "ordered-steering" }),
  orderedWrite: fauxToolCall("write", { path: "src/transcript.ts", content: "" }, { id: "ordered-final" }),
  bash: fauxToolCall("bash", { command: "echo fake" }, { id: "fixture-bash" }),
};

function orderedTranscriptFixture(context: TranscriptContext) {
  const text = userTexts(context).at(-1) ?? "";
  const lastUser = context.messages.findLastIndex((message) => message.role === "user");
  const priorAssistant = context.messages.slice(0, lastUser).findLast((message) => message.role === "assistant");
  const result = context.messages.at(-1);
  if (priorAssistant?.role === "assistant" && priorAssistant.content.some((part) => part.type === "toolCall" && part.id === durableSuiteToolCalls.orderedRead.id)) {
    if (result?.role === "toolResult" && result.toolCallId === durableSuiteToolCalls.orderedWrite.id) {
      return fauxAssistantMessage([
        fauxText("Final response after the second tool."),
        fauxText("Response after an unrendered Native Event boundary."),
      ]);
    }
    return fauxAssistantMessage([
      fauxText(`Steering received: ${text}`),
      fauxText("Adjacent response remains in the same visual reply."),
      fauxThinking("Check the final interleaving."),
      durableSuiteToolCalls.orderedWrite,
    ], { stopReason: "toolUse" });
  }
  if (text === "ordered-transcript") {
    if (result?.role === "toolResult") return fauxAssistantMessage([]);
    return fauxAssistantMessage([
      fauxText(orderedIntro),
      fauxThinking("**Inspect** every ordered boundary."),
      durableSuiteToolCalls.orderedRead,
    ], { stopReason: "toolUse" });
  }
}

function computerFixtureArgs(command: string, value: string) {
  let action = command;
  let args: Record<string, string | number> = {};
  switch (command) {
    case "click": args = { x: 4, y: 5 }; break;
    case "type": args = { text: value }; break;
    case "open_app": args = { app: value }; break;
    case "open_url": args = { url: value }; break;
    case "list_windows": case "screenshot": break;
    default: action = "observe";
  }
  return { action, args };
}

function graphicalToolFixture(context: TranscriptContext) {
  const text = userTexts(context).at(-1) ?? "";
  const [toolName, command, ...tail] = text.split(":");
  if ((toolName !== "browser" && toolName !== "computer") || command === undefined || command === "crash-agent") return undefined;
  const lastUser = context.messages.findLastIndex((message) => message.role === "user");
  const result = context.messages.slice(lastUser + 1).findLast((message) => message.role === "toolResult" && message.toolName === toolName);
  if (result?.role === "toolResult") {
    if (result.isError) {
      const errorMessage = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      return fauxAssistantMessage([], { stopReason: "error", errorMessage });
    }
    return fauxAssistantMessage(JSON.stringify(result.details));
  }
  const value = tail.join(":");
  const params = toolName === "browser"
    ? { action: command, args: value.startsWith("{") ? JSON.parse(value) : {} }
    : computerFixtureArgs(command, value);
  return fauxAssistantMessage([fauxToolCall(toolName, params)], { stopReason: "toolUse" });
}

/** The durable suite's scripted replies. */
export function createDurableSuiteFakeProvider() {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
  // The worker emits graphical responses and ordered transcript blocks at once.
  const immediate = fauxProvider({ provider: "fake" });
  const failedSessions = new Set<string>();
  fake.setResponses(Array.from({ length: 1000 }, () => (context: TranscriptContext, options) => {
    const text = userTexts(context).at(-1) ?? "";
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const priorAssistant = context.messages.slice(0, lastUser).findLast((message) => message.role === "assistant");
    const boundary = priorAssistant?.role === "assistant" ? priorAssistant.content.find((part) => part.type === "toolCall" && part.name === "steer_boundary") : undefined;
    if (boundary?.type === "toolCall" && boundary.id === "steer-boundary") return fauxAssistantMessage(`steered: ${text}`);
    if (text === "steer-echo") return fauxAssistantMessage([fauxToolCall("steer_boundary", {}, { id: "steer-boundary" })], { stopReason: "toolUse" });
    const localRun = /^local\.run(?:@(dev_[0-9a-f]{32}|this-device))?:(.*)$/.exec(text);
    const forgedLocalRun = text.startsWith("local.run.forged:");
    if (localRun || forgedLocalRun) {
      const latest = context.messages.at(-1);
      if (latest?.role === "toolResult" && latest.toolName === "local") return fauxAssistantMessage("Local call finished.");
      const args = localRun
        ? { action: "run", command: localRun[2]!, ...(localRun[1] === undefined ? {} : { target: localRun[1] }) }
        : { action: "run", command: text.slice("local.run.forged:".length), botId: "wrong-bot", turnId: "wrong-turn" };
      return fauxAssistantMessage(fauxToolCall("local", args, { id: "local-run" }), { stopReason: "toolUse" });
    }
    if (text.startsWith("mcp-durable: ")) {
      const action = text.slice("mcp-durable: ".length);
      const latest = context.messages.at(-1);
      const result = action === "recall" ? context.messages.slice(0, lastUser).findLast((message) => message.role === "toolResult" && message.toolName === "mcp") : latest;
      if (result?.role === "toolResult" && result.toolName === "mcp") {
        return fauxAssistantMessage(result.content.flatMap((part) => part.type === "text" ? [fauxText(action === "recall" ? `Recalled ${part.text}` : part.text)] : []));
      }
      if (action === "recall") return fauxAssistantMessage("MCP result missing from history");
      const account = action === "account";
      return fauxAssistantMessage([fauxToolCall("mcp", {
        action: "call", service: account ? "service-fixture-github" : "local", tool: "reflect",
        arguments: account ? {} : { message: action === "block" ? "block" : "hello" },
      })], { stopReason: "toolUse" });
    }
    if (text === "parity-stream") return fauxAssistantMessage([fauxThinking("T"), fauxText("R")]);
    const latest = context.messages.at(-1);
    const continued = latest?.role === "toolResult";
    if (text === "thinking-order") {
      if (latest?.role === "toolResult" && latest.toolCallId === durableSuiteToolCalls.thinking.id) {
        return fauxAssistantMessage([fauxThinking("Provider-authored summary."), fauxText("After Thinking.")]);
      }
      return fauxAssistantMessage([
        fauxText("Before Thinking."),
        fauxThinking("**Inspect** the request."),
        durableSuiteToolCalls.thinking,
      ], { stopReason: "toolUse" });
    }
    if (text === "process-only") {
      if (continued) return Bun.sleep(150).then(() => fauxAssistantMessage([]));
      return fauxAssistantMessage([fauxThinking("Hidden process reasoning."), durableSuiteToolCalls.process], { stopReason: "toolUse" });
    }
    if (text === "tool" || text === "tool please") {
      if (continued) return fauxAssistantMessage("tool finished");
      return fauxAssistantMessage(durableSuiteToolCalls.bash, { stopReason: "toolUse" });
    }
    if (text === "thinking-stream") return fauxAssistantMessage([fauxThinking("**Inspect inputs.**"), fauxText("Thinking complete.")]);
    if (text === "adjacent-responses") return fauxAssistantMessage([fauxText("First block."), fauxText("Second block.")]);
    if (text === "thinking-fail" || text === "thinking-crash" || text === "thinking-hang") return fauxAssistantMessage([fauxThinking("discard me")], text === "thinking-hang" ? {} : { stopReason: "error", errorMessage: text === "thinking-fail" ? "fake Thinking failure" : "Agent process loss" });
    if (text === "partial-fail" || text === "partial-crash") return fauxAssistantMessage([fauxText("discard me")], { stopReason: "error", errorMessage: text === "partial-fail" ? "fake partial failure" : "Agent process loss" });
    if (text === "fail-once") {
      const session = options?.sessionId ?? "default";
      if (failedSessions.has(session)) return fauxAssistantMessage("recovered");
      failedSessions.add(session);
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "fake failure" });
    }
    if (text === "timeout-failure" || text === "fail") return fauxAssistantMessage([], { stopReason: "error", errorMessage: text === "fail" ? "fake failure" : "fake deadline exceeded" });
    if (text === "hang") return fauxAssistantMessage("hanging…");
    return fauxAssistantMessage(text.startsWith("say:") ? [fauxText(text.slice(4).trim())] : []);
  }));
  // Mail validation includes an oversized argument, so its fixtures stream without pacing.
  const mailbox = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  mailbox.setResponses(Array.from({ length: 1000 }, () => async (context: TranscriptContext, options) => {
    const text = userTexts(context).at(-1) ?? "";
    const mail = /^send_bot_message:([^:]*):([\s\S]*)$/.exec(text);
    if (mail) {
      const latest = context.messages.at(-1);
      if (latest?.role === "toolResult" && latest.toolName === "send_bot_message") {
        const details = latest.details;
        const deliveryId = details && typeof details === "object" && "deliveryId" in details ? details.deliveryId : undefined;
        return fauxAssistantMessage(!latest.isError && typeof deliveryId === "string"
          ? `Bot message acknowledgements: ${deliveryId} queued.`
          : []);
      }
      const rawBody = mail[2]!;
      const forged = rawBody.endsWith(":forge-source");
      const args = {
        targetBotId: mail[1]!,
        text: rawBody.replace(/:(?:retry|forge-source)$/, ""),
        ...(forged ? { botId: mail[1]!, turnId: "forged-turn" } : {}),
      };
      return fauxAssistantMessage(fauxToolCall("send_bot_message", args, { id: "mail-send" }), { stopReason: "toolUse" });
    }
    const peerMail = /^Message from Bot [^\n]+?: ([\s\S]*)$/.exec(text);
    if (peerMail?.[1] === "mailbox-ordered-output") {
      const latest = context.messages.at(-1);
      if (latest?.role === "toolResult" && latest.toolName === "read") return fauxAssistantMessage("Peer mail handled.");
      return fauxAssistantMessage([
        fauxThinking("Review the isolated peer mail."),
        fauxToolCall("read", { path: "mailbox-input" }, { id: "mail-read" }),
      ], { stopReason: "toolUse" });
    }
    if (peerMail?.[1] === "mailbox-fail-after-acceptance") {
      const home = process.env.OMARCHY_BOT_HOME;
      const release = home === undefined ? undefined : path.join(home, "fake-peer-mail-failure.release");
      while (release !== undefined && !existsSync(release) && !options?.signal?.aborted) await Bun.sleep(10);
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "fake peer-mail failure" });
    }
    return fauxAssistantMessage([]);
  }));
  const base = fake.provider;
  const streamSimple: typeof base.streamSimple = (model, context, options) => {
    const reply = graphicalToolFixture(context) ?? orderedTranscriptFixture(context);
    if (reply !== undefined) {
      immediate.appendResponses([reply]);
      return immediate.provider.streamSimple(model, context, options);
    }
    const text = userTexts(context).at(-1);
    if (text?.startsWith("send_bot_message:") || text?.startsWith("Message from Bot ")) {
      return mailbox.provider.streamSimple(model, context, options);
    }
    const hanging = text === "hang" || text === "thinking-hang";
    const interrupted = hanging || text === "thinking-fail" || text === "thinking-crash" || text === "partial-fail" || text === "partial-crash";
    const inner = base.streamSimple(model, context, options);
    if (!interrupted && text !== "thinking-stream") return inner;
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let thinkingStarted = false;
      for await (const event of inner) {
        if (text === "thinking-stream" && event.type === "thinking_delta") {
          if (!thinkingStarted) {
            thinkingStarted = true;
            await Bun.sleep(250);
            const partial = structuredClone(event.partial);
            const block = partial.content[event.contentIndex];
            if (block?.type === "thinking") block.thinking = "**Inspect";
            outer.push({ ...event, delta: "**Inspect", partial });
            await Bun.sleep(700);
            const final = structuredClone(partial);
            const finalBlock = final.content[event.contentIndex];
            if (finalBlock?.type === "thinking") finalBlock.thinking = "**Inspect inputs.**";
            outer.push({ ...event, delta: " inputs.**", partial: final });
            await Bun.sleep(700);
          }
          continue;
        }
        if (interrupted && (event.type === "text_end" || event.type === "thinking_end")) continue;
        if (hanging && event.type === "done") {
          const aborted = { ...event.message, content: [], stopReason: "aborted" as const, errorMessage: "Request was aborted" };
          const abort = () => { outer.push({ type: "error", reason: "aborted", error: aborted }); outer.end(aborted); };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
          return;
        }
        if (interrupted && event.type === "error") {
          const error = { ...event.error, content: [] };
          outer.push({ ...event, error });
          outer.end(error);
          return;
        }
        outer.push(event);
      }
    })();
    return outer;
  };
  return { ...fake, provider: { ...base, streamSimple }, getCallCount: () => fake.state.callCount + immediate.state.callCount + mailbox.state.callCount };
}
