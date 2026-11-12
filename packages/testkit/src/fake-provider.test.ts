import { expect, test } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createModels } from "@earendil-works/pi-ai/models";
import { createDurableSuiteFakeProvider } from "./fake-provider.ts";

function suite() {
  const fake = createDurableSuiteFakeProvider();
  const models = createModels();
  models.setProvider(fake.provider);
  return (text: string, signal?: AbortSignal) => models.streamSimple(fake.getModel(), { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, signal ? { signal } : undefined);
}

test("durable scripts preserve text and thinking block order", async () => {
  const run = suite();
  expect((await run("parity-stream").result()).content).toEqual([{ type: "thinking", thinking: "T" }, { type: "text", text: "R" }]);
  expect((await run("adjacent-responses").result()).content).toEqual([{ type: "text", text: "First block." }, { type: "text", text: "Second block." }]);
  expect((await run("thinking-order").result()).content.map((part) => part.type)).toEqual(["text", "thinking", "thinking", "text"]);
  expect((await run("ordinary prompt").result()).content).toEqual([]);
  expect((await run("redirect now").result()).content).toEqual([]);
  expect((await run("say:  hello  ").result()).content).toEqual([{ type: "text", text: "hello" }]);
});

test("durable scripts fail with worker fixture reasons and retain partial stream deltas", async () => {
  const run = suite();
  expect((await run("fail-once").result()).errorMessage).toBe("fake failure");
  expect((await run("fail-once").result()).content).toEqual([{ type: "text", text: "recovered" }]);
  expect((await run("timeout-failure").result()).errorMessage).toBe("fake deadline exceeded");
  for (const text of ["thinking-fail", "thinking-crash", "partial-fail", "partial-crash"]) {
    const events = [];
    for await (const event of run(text)) events.push(event.type);
    expect(events).toContain(text.startsWith("thinking") ? "thinking_delta" : "text_delta");
    expect(events).not.toContain(text.startsWith("thinking") ? "thinking_end" : "text_end");
    expect(events.at(-1)).toBe("error");
    expect((await run(text).result()).content).toEqual([]);
  }
});

test("durable hanging scripts remain open until aborted", async () => {
  const run = suite();
  for (const script of ["hang", "thinking-hang"]) {
    const controller = new AbortController();
    const stream = run(script, controller.signal);
    const seen: string[] = [];
    const reading = (async () => { for await (const event of stream) { seen.push(event.type); if (event.type === "text_delta" || event.type === "thinking_delta") controller.abort(); } })();
    await reading;
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(seen).toContain("error");
    expect(seen).not.toContain("done");
  }
});

test("steer fixtures call a boundary before responding", async () => {
  const run = suite();
  for (const script of ["steer-echo", "ordered-transcript"]) {
    const response = await run(script).result();
    expect(response.stopReason).toBe("toolUse");
    expect(response.content.at(-1)).toMatchObject({ type: "toolCall", name: "steer_boundary" });
  }
}, 20000);


test("timeout failure makes one provider call and is not retryable", async () => {
  const fake = createDurableSuiteFakeProvider();
  const models = createModels();
  models.setProvider(fake.provider);
  const response = await models.streamSimple(fake.getModel(), { messages: [{ role: "user", content: "timeout-failure", timestamp: Date.now() }] }).result();
  expect(response.errorMessage).toBe("fake deadline exceeded");
  expect(fake.state.callCount).toBe(1);
  expect(isRetryableAssistantError(response)).toBeFalse();
});

test("thinking stream emits two spaced deltas", async () => {
  const run = suite();
  const chunks: string[] = [];
  const start = Date.now();
  for await (const event of run("thinking-stream")) {
    if (event.type === "thinking_delta") chunks.push(event.delta);
    if (event.type === "thinking_end") expect(Date.now() - start).toBeGreaterThanOrEqual(1300);
  }
  expect(chunks).toEqual(["**Inspect", " inputs.**"]);
});
