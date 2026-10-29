import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { apiStatus, startDaemon, type Harness } from "./helpers/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startDaemon();
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("retired dictation HTTP API", () => {
  for (const [method, requestPath] of [
    ["GET", "/api/dictation"],
    ["POST", "/api/dictation/start"],
    ["POST", "/api/dictation/stop"],
    ["POST", "/api/dictation/cancel"],
  ] as const) {
    test(`${method} ${requestPath} follows ordinary missing-interface behavior`, async () => {
      const response = await apiStatus(h, method, requestPath);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "not found" });
    });
  }
});
