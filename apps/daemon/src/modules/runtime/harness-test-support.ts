// This test helper lives here to satisfy the pi-durable module boundary rule.
// No production module imports this test-only helper.
import { Harness } from "@earendil-works/pi-durable";
import { createFakeProvider, type FakeReply } from "../../../../../packages/testkit/src/fake-provider.ts";

export async function withFakeRuntimeProvider<T>(script: FakeReply[], options: { tokensPerSecond?: number }, fn: () => Promise<T>): Promise<T> {
  const fake = createFakeProvider(script, options);
  const originalOpen = Harness.open;
  Harness.open = (storage, options, context) => originalOpen.call(Harness, storage, {
    ...options,
    models: () => {
      const models = typeof options.models === "function" ? options.models() : options.models;
      if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
      models.setProvider(fake.provider);
      return models;
    },
  }, context);
  try {
    return await fn();
  } finally {
    Harness.open = originalOpen;
  }
}
