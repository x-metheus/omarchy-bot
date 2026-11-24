import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export type FakeSegment = { type: "text" | "thinking"; text: string };
export type FakeReply = { segments: FakeSegment[]; failure?: string };

/** A network-free pi-ai provider whose responses emit ordered text/thinking deltas. */
export function createFakeProvider(replies: FakeReply[], options: { tokensPerSecond?: number } = {}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], ...options, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(replies.map((reply) => fauxAssistantMessage(reply.segments.map((s) => s.type === "text" ? fauxText(s.text) : fauxThinking(s.text)), reply.failure === undefined ? {} : { stopReason: "error", errorMessage: reply.failure })));
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

/**
 * The durable suite's text/thinking fixtures. Tool-call and native-event transcript
 * projection, capability inventory, process-only, computer/browser, attachments,
 * and mailbox fixtures belong to Checkpoint C: those in-process tools are not built.
 * Task 20 worker-only cases cover session IDs/resume/open failures, steering command
 * mechanics, abort controls, worker/process-loss events, and Agent readiness.
 */
export function createDurableSuiteFakeProvider() {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
  const failedSessions = new Set<string>();
  fake.setResponses(Array.from({ length: 1000 }, () => (context: TranscriptContext, options) => {
    const texts = userTexts(context);
    const text = texts.at(-1) ?? "";
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const priorAssistant = context.messages.slice(0, lastUser).findLast((message) => message.role === "assistant");
    const boundary = priorAssistant?.role === "assistant" ? priorAssistant.content.find((part) => part.type === "toolCall" && part.name === "steer_boundary") : undefined;
    if (boundary?.type === "toolCall" && boundary.id === "steer-boundary") return fauxAssistantMessage(`steered: ${text}`);
    if (boundary?.type === "toolCall" && boundary.id === "ordered-steering") {
      return fauxAssistantMessage([fauxText(`Steering received: ${text}`), fauxText("Adjacent response remains in the same visual reply."), fauxThinking("Check the final interleaving.")]);
    }
    if (text === "ordered-transcript") return fauxAssistantMessage([fauxText(orderedIntro), fauxThinking("**Inspect** every ordered boundary."), fauxToolCall("steer_boundary", {}, { id: "ordered-steering" })], { stopReason: "toolUse" });
    if (text === "steer-echo") return fauxAssistantMessage([fauxToolCall("steer_boundary", {}, { id: "steer-boundary" })], { stopReason: "toolUse" });
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
    // The worker inserts a read tool between these thinking blocks; asserting it is Checkpoint C.
    if (text === "thinking-order") return fauxAssistantMessage([fauxText("Before Thinking."), fauxThinking("**Inspect** the request."), fauxThinking("Provider-authored summary."), fauxText("After Thinking.")]);
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
  const base = fake.provider;
  const streamSimple: typeof base.streamSimple = (model, context, options) => {
    const text = userTexts(context).at(-1);
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
  return { ...fake, provider: { ...base, streamSimple } };
}
