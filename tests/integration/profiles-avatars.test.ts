import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import sharp from "../../apps/daemon/node_modules/sharp";
import type { AgentId } from "../../packages/domain/src/index.ts";
import { AVATAR_RENDERER_ID, AVATAR_STYLE_IDS, AvatarRecipeDto, type BotDto } from "../../packages/protocol/src/index.ts";
import { handleAvatarRequest } from "../../apps/daemon/src/api/avatarRoutes.ts";
import { AvatarService, type AvatarSupervisor } from "../../apps/daemon/src/modules/avatars/avatarService.ts";
import { HttpError } from "../../apps/daemon/src/modules/bots/bots.ts";
import { renderAvatarRecipe } from "../../apps/web/src/components/avatarRenderer.ts";
import { api, apiStatus, makeBot, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

let h: Harness;
let avatars: AvatarService;
let agentOutput = JSON.stringify({ style: "thumbs", seed: "calm-blue", options: {} });
let agentFailure: string | undefined;
let openedInstructions = "";
let closedSessions = 0;
let sessionCounter = 0;

const worker = {
  async request(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "session.open") {
      const options = command.options;
      if (options === null || typeof options !== "object" || !("instructions" in options) || typeof options.instructions !== "string") {
        throw new Error("avatar session did not receive recipe instructions");
      }
      openedInstructions = options.instructions;
      return { sessionId: `avatar-session-${++sessionCounter}`, nativeSessionId: `avatar-native-${sessionCounter}` };
    }
    if (command.type === "message.send") {
      const sessionId = command.sessionId;
      if (typeof sessionId !== "string") throw new Error("avatar message has no session id");
      queueMicrotask(() => {
        const failure = agentFailure;
        if (failure !== undefined) {
          avatars.onAgentEvent("pi", { type: "error", sessionId, message: failure, retryable: false });
          return;
        }
        avatars.onAgentEvent("pi", {
          type: "response.delta",
          sessionId,
          blockId: `avatar-response-${sessionCounter}`,
          text: agentOutput,
        });
        avatars.onAgentEvent("pi", { type: "turn.completed", sessionId });
      });
      return { accepted: true };
    }
    if (command.type === "session.close") {
      closedSessions += 1;
      return { closed: true };
    }
    throw new Error(`unexpected worker command ${String(command.type)}`);
  },
};

const supervisor: AvatarSupervisor = {
  async agentWorker(_agentId: AgentId) {
    return worker;
  },
};

async function avatarRequest(method: string, pathname: string, init: { json?: unknown; bytes?: Uint8Array; contentType?: string } = {}) {
  const headers = new Headers();
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.bytes !== undefined) {
    headers.set("content-type", init.contentType ?? "application/octet-stream");
    body = init.bytes as unknown as BodyInit;
  }
  const req = new Request(`http://localhost${pathname}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  try {
    return (await handleAvatarRequest(req, avatars, pathname)) ?? new Response(null, { status: 404 });
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers: { "content-type": "application/json" } });
    }
    throw error;
  }
}
function svgFromDataUri(dataUri: string | undefined): string {
  if (dataUri === undefined) throw new Error("avatar recipe was not rendered");
  const separator = dataUri.indexOf(",");
  if (separator === -1) throw new Error("avatar renderer returned an invalid data URI");
  return decodeURIComponent(dataUri.slice(separator + 1));
}

describe("pinned local avatar renderers", () => {
  test("renders every supported current style with native DiceBear animation", () => {
    for (const style of AVATAR_STYLE_IDS) {
      const recipe: AvatarRecipeDto = {
        rendererVersion: AVATAR_RENDERER_ID,
        style,
        seed: `animated-${style}`,
        options: {},
      };

      const svg = svgFromDataUri(renderAvatarRecipe(recipe, "working"));
      expect(svg).toContain("@keyframes");
      expect(svg).toContain("@media (prefers-reduced-motion: no-preference)");
    }
  });

  test("rejects recipes from unsupported renderer versions", () => {
    expect(
      AvatarRecipeDto.safeParse({
        rendererVersion: "9.4.3",
        style: "micah",
        seed: "legacy-micah",
        options: { flip: true },
      }).success,
    ).toBeFalse();
  });
});

beforeAll(async () => {
  h = await startDaemon();
  avatars = new AvatarService(h.svc.bots, supervisor, h.svc.cfg.avatarsDir, { timeoutMs: 2_000 });
}, 30_000);

afterAll(async () => {
  await h?.stop();
  if (h?.home) rmSync(h.home, { recursive: true, force: true });
});

describe("bot profile editing", () => {
  test("new avatars are deterministic and generated variations follow the stable sequence", async () => {
    const botId = await makeBot(h, "Recipe Bot");
    const initial = await api<BotDto>(h, "GET", `/api/bots/${botId}`);
    expect(initial.avatar).toEqual({
      kind: "generated",
      recipe: { rendererVersion: AVATAR_RENDERER_ID, style: "pixelbot", seed: botId, options: {} },
    });

    const first = await avatars.generate(botId);
    const second = await avatars.generate(botId);
    expect(first.avatar.kind).toBe("generated");
    expect(second.avatar.kind).toBe("generated");
    if (first.avatar.kind === "generated" && second.avatar.kind === "generated") {
      expect(first.avatar.recipe.style).toBe("clay");
      expect(second.avatar.recipe.style).toBe("critters");
      expect(first.avatar.recipe.seed).toBe(createHash("sha256").update(`${botId}:1`).digest("hex"));
      expect(second.avatar.recipe.seed).toBe(createHash("sha256").update(`${botId}:2`).digest("hex"));
    }
  });

  test("edits name and instructions, keeps Agent immutable, and supplies current instructions to future sessions", async () => {
    const botId = await makeBot(h, "Before", "old instructions");
    const first = await sendToBot(h, botId, "say: keep this message");
    await waitThreadIdle(h, first.threadId);

    const changed = await api<BotDto>(h, "PATCH", `/api/bots/${botId}`, { name: "After", instructions: "current instructions" });
    expect(changed.name).toBe("After");
    expect(changed.instructions).toBe("current instructions");
    expect(changed.agentId).toBe("pi");
    const immutable = await apiStatus(h, "PATCH", `/api/bots/${botId}`, { agentId: "claude" });
    expect(immutable.status).toBe(400);
    expect(
      immutable.body !== null && typeof immutable.body === "object" && "error" in immutable.body
        ? immutable.body.error
        : undefined,
    ).toContain("agent");

    const originalAgentWorker = h.svc.supervisor.agentWorker.bind(h.svc.supervisor);
    let turnInstructions: unknown;
    h.svc.supervisor.agentWorker = async (agentId) => {
      const liveWorker = await originalAgentWorker(agentId);
      return new Proxy(liveWorker, {
        get(target, property) {
          // `target`, not `receiver`: WorkerClient reads its private `#proc`
          // field, which throws through a Proxy whose receiver is the proxy.
          if (property !== "request") return Reflect.get(target, property, target);
          return async (command: Record<string, unknown>, timeoutMs: number) => {
            if (command.type === "session.resume" || command.type === "session.open") {
              const options = command.options;
              if (options !== null && typeof options === "object" && "instructions" in options) {
                turnInstructions = options.instructions;
              }
            }
            return target.request(command, timeoutMs);
          };
        },
      });
    };
    try {
      const second = await sendToBot(h, botId, "say: second message");
      await waitThreadIdle(h, second.threadId);
      expect(turnInstructions).toBe("current instructions");
    } finally {
      h.svc.supervisor.agentWorker = originalAgentWorker;
    }

    const messages = await api<{ text?: string }[]>(h, "GET", `/api/threads/${first.threadId}/messages`);
    expect(messages.some((message) => message.text === "keep this message")).toBeTrue();
  }, 20_000);
});

describe("safe local avatar uploads", () => {
  test("decodes, crops to at most 512px, strips metadata, re-encodes PNG, and serves locally", async () => {
    const botId = await makeBot(h, "Upload Bot");
    const jpeg = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 20, g: 90, b: 170 } },
    })
      .withMetadata({ exif: { IFD0: { Artist: "must be stripped" } } })
      .jpeg()
      .toBuffer();

    const uploadedResponse = await avatarRequest("POST", `/api/bots/${botId}/avatar/upload`, {
      bytes: jpeg,
      contentType: "image/jpeg",
    });
    expect(uploadedResponse.status).toBe(200);
    const uploaded = (await uploadedResponse.json()) as BotDto;
    expect(uploaded.avatar).toEqual({ kind: "upload", url: `/api/bots/${botId}/avatar` });

    const served = await avatarRequest("GET", `/api/bots/${botId}/avatar`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await served.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBeLessThanOrEqual(512);
    expect(metadata.height).toBeLessThanOrEqual(512);
    expect(metadata.exif).toBeUndefined();
  });

  test("rejects oversized, unsupported, and undecodable uploads without changing the avatar", async () => {
    const botId = await makeBot(h, "Rejected Upload Bot");
    const before = await api<BotDto>(h, "GET", `/api/bots/${botId}`);
    const oversized = await avatarRequest("POST", `/api/bots/${botId}/avatar/upload`, {
      bytes: new Uint8Array(8 * 1024 * 1024 + 1),
      contentType: "image/png",
    });
    expect(oversized.status).toBe(400);
    const unsupported = await avatarRequest("POST", `/api/bots/${botId}/avatar/upload`, {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/svg+xml",
    });
    expect(unsupported.status).toBe(400);
    const corrupt = await avatarRequest("POST", `/api/bots/${botId}/avatar/upload`, {
      bytes: new TextEncoder().encode("not an image"),
      contentType: "image/png",
    });
    expect(corrupt.status).toBe(422);
    expect((await api<BotDto>(h, "GET", `/api/bots/${botId}`)).avatar).toEqual(before.avatar);
  });
});

describe("Agent-authored avatar recipe boundary", () => {
  test("runs outside Thread history and stores only a validated pinned recipe", async () => {
    const botId = await makeBot(h, "Agent Recipe Bot");
    agentFailure = undefined;
    agentOutput = JSON.stringify({ style: "clay", seed: "calm-blue", options: {} });
    const beforeThreads = await api<unknown[]>(h, "GET", `/api/bots/${botId}/threads`);
    const response = await avatarRequest("POST", `/api/bots/${botId}/avatar/recipe`, { json: { prompt: "calm blue teammate" } });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as BotDto;
    expect(updated.avatar).toEqual({
      kind: "recipe",
      recipe: { rendererVersion: AVATAR_RENDERER_ID, style: "clay", seed: "calm-blue", options: {} },
    });
    expect(openedInstructions).toContain("Reply with exactly one JSON object");
    expect(closedSessions).toBeGreaterThan(0);
    expect(await api<unknown[]>(h, "GET", `/api/bots/${botId}/threads`)).toEqual(beforeThreads);
  });

  test("rejects invalid styles, options, SVG, HTML, script, and remote URLs while preserving the old avatar", async () => {
    const botId = await makeBot(h, "Boundary Bot");
    const before = await api<BotDto>(h, "GET", `/api/bots/${botId}`);
    const hostileOutputs = [
      JSON.stringify({ style: "micah", seed: "x", options: {} }),
      JSON.stringify({ style: "clay", seed: "x", options: { backgroundColor: "ff0000" } }),
      "<svg><script>alert(1)</script></svg>",
      "<html><img src=https://example.test/avatar.png></html>",
      JSON.stringify({ style: "thumbs", seed: "https://example.test/avatar.png", options: {} }),
    ];
    for (const output of hostileOutputs) {
      agentOutput = output;
      const response = await avatarRequest("POST", `/api/bots/${botId}/avatar/recipe`, { json: { prompt: "hostile output" } });
      expect(response.status).toBe(422);
      expect((await api<BotDto>(h, "GET", `/api/bots/${botId}`)).avatar).toEqual(before.avatar);
    }
  });

  test("maps Agent failure to 502 and leaves the previous avatar unchanged", async () => {
    const botId = await makeBot(h, "Failed Recipe Bot");
    const before = await api<BotDto>(h, "GET", `/api/bots/${botId}`);
    agentFailure = "model unavailable";
    const response = await avatarRequest("POST", `/api/bots/${botId}/avatar/recipe`, { json: { prompt: "blue bot" } });
    expect(response.status).toBe(502);
    expect((await api<BotDto>(h, "GET", `/api/bots/${botId}`)).avatar).toEqual(before.avatar);
    agentFailure = undefined;
  });
});
