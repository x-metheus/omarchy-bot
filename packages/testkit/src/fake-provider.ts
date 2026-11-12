import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";

export type FakeSegment = { type: "text" | "thinking"; text: string };
export type FakeReply = { segments: FakeSegment[]; failure?: string };

/** A network-free pi-ai provider whose responses emit ordered text/thinking deltas. */
export function createFakeProvider(replies: FakeReply[], options: { tokensPerSecond?: number } = {}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], ...options, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(replies.map((reply) => fauxAssistantMessage(reply.segments.map((s) => s.type === "text" ? fauxText(s.text) : fauxThinking(s.text)), reply.failure === undefined ? {} : { stopReason: "error", errorMessage: reply.failure })));
  return fake;
}
