# Test providers

`createFakeProvider` returns a pi-ai faux provider with no network access. Register `fake.provider` on a `createModels()` collection and use `fake.getModel()` for the model. Responses are consumed in script order:

```ts
const fake = createFakeProvider([
  { segments: [{ type: "thinking", text: "Let me consider" }, { type: "text", text: "Here is the answer" }] },
  { segments: [], failure: "scripted failure" },
], { tokensPerSecond: 50 });
```

Segments stream in order with text and thinking deltas. `tokensPerSecond` controls delivery speed; omit it for immediate delivery. A `failure` yields a pi-ai error response. The returned faux handle also supports `setResponses` and call-count inspection.

One fake handle consumes queued replies in order. For a two-path comparison, build a second handle from the same script. This fake drives the pi-ai runtime side only; it does not emit agent-protocol events.
