import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, apiStatus, makeBot, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startDaemon();
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

interface MessageView {
  id: string;
  threadId: string;
  seq: number;
  author: { kind: string };
  kind: string;
  text?: string;
  payload?: Record<string, unknown>;
  toolCall?: {
    id: string;
    name: string;
    status: "running" | "completed" | "error";
    target?: string;
    durationMs?: number;
    additions?: number;
    deletions?: number;
    errorSummary?: string;
  };
  createdAt: string;
}

async function messages(threadId: string): Promise<MessageView[]> {
  return api(h, "GET", `/api/threads/${threadId}/messages`);
}

/** Poll until a condition holds — avoids fixed sleeps on real-process races. */
async function until(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("condition did not hold in time");
    await Bun.sleep(50);
  }
}

test("daemon shutdown cancels active Turn timeouts before closing persistence", async () => {
  const daemon = await startDaemon();
  try {
    daemon.svc.cfg.turnTimeoutMs = 100;
    const botId = await makeBot(daemon, "Shutdown timeout");
    const sent = await sendToBot(daemon, botId, "hang");
    await until(async () => {
      const thread = await api<{ activeTurn?: { status: string } }>(daemon, "GET", `/api/threads/${sent.threadId}`);
      return thread.activeTurn?.status === "working";
    });
    await daemon.svc.turns.shutdown();
    const rejected = await apiStatus(daemon, "POST", `/api/bots/${botId}/messages`, { text: "late work" });
    expect(rejected.status).toBe(503);
    await daemon.stop();
    // Real worker shutdown races the platform timeout; fake timers cannot drive the child process.
    await Bun.sleep(5_500);
    const restarted = await startDaemon(daemon.home);
    try {
      const thread = await api<{ latestTurn?: { status: string } }>(restarted, "GET", `/api/threads/${sent.threadId}`);
      expect(thread.latestTurn?.status).toBe("failed");
      const agents = await api<{ id: string; status: string }[]>(restarted, "GET", "/api/agents");
      expect(agents.find((agent) => agent.id === "pi")?.status).toBe("ready");
    } finally {
      await restarted.stop();
    }
  } finally {
    await daemon.stop();
  }
}, 15_000);

describe("integration: agents API", () => {
  test("lists all nine agents with version/status/reason/guidance fields", async () => {
    const agents = await api<{ id: string; displayName: string; version: string; status: string; reason?: string; guidance?: string }[]>(h, "GET", "/api/agents");
    expect(agents.length).toBe(9);
    const ids = agents.map((a) => a.id);
    for (const expected of ["pi", "omp", "codex", "claude", "grok", "opencode", "gemini", "copilot", "crush"]) {
      expect(ids).toContain(expected);
    }
    for (const a of agents) {
      expect(typeof a.displayName).toBe("string");
      expect(typeof a.version).toBe("string");
      expect(["ready", "missing", "unconfigured", "incompatible", "checking", "offline"]).toContain(a.status);
    }
    const pi = agents.find((a) => a.id === "pi")!;
    expect(pi.status).toBe("ready");
    expect(pi.version).toBe("fake-pi-1");
    // Unavailable agents carry plain-language guidance.
    const unavailable = agents.filter((a) => a.status !== "ready" && a.status !== "checking");
    expect(unavailable.length).toBeGreaterThan(0);
    for (const a of unavailable) expect(typeof a.guidance).toBe("string");
  });

  test("keeps its worker environment when process configuration changes", async () => {
    const foreignHome = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-foreign-home-"));
    const priorHome = process.env.OMARCHY_BOT_HOME;
    let imageCapability: boolean | undefined;
    try {
      process.env.OMARCHY_BOT_HOME = foreignHome;
      await h.svc.supervisor.stopAgentWorker("pi");
      imageCapability = (await h.svc.agents.recheck("pi")).capabilities?.attachments.image;
    } finally {
      if (priorHome === undefined) delete process.env.OMARCHY_BOT_HOME;
      else process.env.OMARCHY_BOT_HOME = priorHome;
      await h.svc.supervisor.stopAgentWorker("pi");
      await h.svc.agents.recheck("pi");
      rmSync(foreignHome, { recursive: true, force: true });
    }
    expect(imageCapability).toBeTrue();
  }, 15_000);
});

describe("integration: bots API", () => {
  test("rejects bot creation for a non-ready agent with guidance", async () => {
    const res = await apiStatus(h, "POST", "/api/bots", { name: "Nope", instructions: "", agentId: "claude" });
    expect(res.status).toBe(400);
    expect(typeof (res.body as { error?: string }).error).toBe("string");
  });

  test("rejects bot creation for an unknown agent", async () => {
    const res = await apiStatus(h, "POST", "/api/bots", { name: "Nope", instructions: "", agentId: "nonsense" });
    expect(res.status).toBe(400);
  });

  test("rejects empty names", async () => {
    const res = await apiStatus(h, "POST", "/api/bots", { name: "   ", instructions: "", agentId: "pi" });
    expect(res.status).toBe(400);
  });

  test("two bots on one agent get independent ids", async () => {
    const a = await api<{ id: string; name: string; agentId: string; avatar: { kind: string } }>(h, "POST", "/api/bots", { name: "Alpha", instructions: "alpha job", agentId: "pi" });
    const b = await api<{ id: string; name: string; agentId: string }>(h, "POST", "/api/bots", { name: "Beta", instructions: "beta job", agentId: "pi" });
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith("bot_")).toBeTrue();
    expect(b.id.startsWith("bot_")).toBeTrue();
    expect(a.agentId).toBe("pi");
    expect(b.agentId).toBe("pi");
    expect(a.avatar.kind).toBe("generated");
  });

  test("PATCH cannot change agentId", async () => {
    const botId = await makeBot(h, "Patched");
    const res = await apiStatus(h, "PATCH", `/api/bots/${botId}`, { agentId: "claude" });
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toContain("agent");
  });

  test("PATCH updates name and instructions", async () => {
    const botId = await makeBot(h, "Before");
    const updated = await api<{ name: string; instructions: string }>(h, "PATCH", `/api/bots/${botId}`, { name: "After", instructions: "new job" });
    expect(updated.name).toBe("After");
    expect(updated.instructions).toBe("new job");
  });

  test("GET /api/bots returns user-created bots with activity status", async () => {
    const bots = await api<{ id: string; status: string; unreadCount: number }[]>(h, "GET", "/api/bots");
    expect(bots.length).toBeGreaterThan(0);
    for (const b of bots) {
      expect(b.id.startsWith("bot_")).toBeTrue();
      expect(["active", "inactive"]).toContain(b.status);
      expect(typeof b.unreadCount).toBe("number");
    }
  });
});

describe("integration: chat through a bot", () => {
  test("first send atomically creates thread + user message + turn and derives a title", async () => {
    const botId = await makeBot(h, "Chatter");
    const result = await sendToBot(h, botId, "say: hello world");
    expect(result.action).toBe("sent");
    expect(result.threadId).toBeTruthy();
    expect(result.turnId).toBeTruthy();
    await waitThreadIdle(h, result.threadId);
    const thread = await api<{ id: string; botId: string; title: string }>(h, "GET", `/api/threads/${result.threadId}`);
    expect(thread.botId).toBe(botId);
    expect(thread.title).toContain("say: hello world");
    const msgs = await messages(result.threadId);
    expect(msgs.some((m) => m.author.kind === "user" && m.text === "say: hello world")).toBeTrue();
    const responses = msgs.filter((message) => message.kind === "response").map((message) => message.text ?? "").join("");
    expect(responses).toContain("hello world");
  });

  test("an abandoned blank conversation persists no thread", async () => {
    const botId = await makeBot(h, "Blank");
    const threads = await api<{ botId: string }[]>(h, "GET", `/api/bots/${botId}/threads`);
    expect(threads.length).toBe(0);
  });

  test("worker session is resumed per thread (thread_sessions)", async () => {
    const botId = await makeBot(h, "Resumer");
    const first = await sendToBot(h, botId, "say: one");
    await waitThreadIdle(h, first.threadId);
    // Second turn on the same thread resumes the stored native session.
    const second = await sendToThread(h, first.threadId, "say: two");
    expect(second.turnId).not.toBe(first.turnId);
    await waitThreadIdle(h, first.threadId);
    const msgs = await messages(first.threadId);
    const responses = msgs
      .filter((message) => message.author.kind === "bot" && message.kind === "response")
      .map((message) => message.text ?? "")
      .join("");
    expect(responses).toContain("one");
    expect(responses).toContain("two");
  });

  test("Tool Calls, residual Native Events, and Responses remain distinct records", async () => {
    const botId = await makeBot(h, "Tools");
    const sent = await sendToBot(h, botId, "tool please");
    await waitThreadIdle(h, sent.threadId);
    const msgs = await messages(sent.threadId);
    const tool = msgs.find((message) => message.kind === "tool");
    expect(tool?.toolCall).toEqual({
      id: expect.any(String),
      name: "bash",
      status: "completed",
      target: "echo fake",
      durationMs: 12,
    });
    expect(tool?.payload).toBeUndefined();
    expect(JSON.stringify(tool)).not.toContain("fake output");
    expect(msgs.find((message) => message.kind === "event")?.payload).toEqual({
      capability: "fake.progress",
      sensitivity: "public",
      payload: { stage: "tool-running" },
    });
    expect(msgs.some((message) => message.author.kind === "bot" && message.kind === "response" && message.text === "tool finished")).toBeTrue();
    expect(msgs.some((message) => message.author.kind === "user")).toBeTrue();
  });

  test("a failed turn exposes its terminal reason without adding an operational history message", async () => {
    const botId = await makeBot(h, "Fails");
    const sent = await sendToBot(h, botId, "fail");
    await waitThreadIdle(h, sent.threadId);
    const thread = await api<{ latestTurn?: { status: string; reason?: string } }>(h, "GET", `/api/threads/${sent.threadId}`);
    expect(thread.latestTurn).toEqual(expect.objectContaining({ status: "failed", reason: "fake failure" }));
    const msgs = await messages(sent.threadId);
    expect(msgs.some((m) => m.author.kind === "system" && (m.text ?? "").includes("fake failure"))).toBeFalse();
  });

  test("sending while a turn is active steers instead of starting a turn", async () => {
    const botId = await makeBot(h, "Steerable");
    const sent = await sendToBot(h, botId, "steer-echo");
    await until(async () => (await api<{ activeTurn?: unknown }>(h, "GET", `/api/threads/${sent.threadId}`)).activeTurn !== undefined);
    // Active turn -> steer.
    const steered = await sendToThread(h, sent.threadId, "redirect me");
    expect(steered.action).toBe("steered");
    expect(steered.turnId).toBe(sent.turnId);
    await waitThreadIdle(h, sent.threadId);
    const msgs = await messages(sent.threadId);
    const responses = msgs.filter((message) => message.kind === "response").map((message) => message.text ?? "").join("");
    expect(responses).toContain("steered: redirect me");
    // The steered user message is correlated with the active turn.
    const steerMsg = msgs.find((m) => m.author.kind === "user" && m.text === "redirect me");
    expect(steerMsg?.payload?.turnId).toBe(sent.turnId);
  });

  test("steering a non-steerable (hanging) turn fails cleanly with a transcript note", async () => {
    const botId = await makeBot(h, "Hangs");
    const sent = await sendToBot(h, botId, "hang");
    await until(async () => (await api<{ activeTurn?: unknown }>(h, "GET", `/api/threads/${sent.threadId}`)).activeTurn !== undefined);
    const res = await apiStatus(h, "POST", `/api/threads/${sent.threadId}/messages`, { text: "redirect" });
    expect(res.status).toBe(409);
    // Internal cancellation remains available to delete and timeout flows.
    await h.svc.turns.abortTurn(sent.turnId, "test cleanup");
    await waitThreadIdle(h, sent.threadId);
    const msgs = await messages(sent.threadId);
    expect(msgs.some((m) => m.author.kind === "system" && (m.text ?? "").includes("steer unavailable"))).toBeTrue();
    expect(msgs.some((m) => m.author.kind === "system" && m.kind === "text" && (m.text ?? "").includes("cancel"))).toBeTrue();
  });

  test("tool activity remains while approval and public abort routes are absent", async () => {
    const botId = await makeBot(h, "Tool user");
    const sent = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, sent.threadId);
    const msgs = await messages(sent.threadId);
    expect(msgs.some((m) => m.kind === "tool")).toBeTrue();
    expect(msgs.some((m) => m.kind === "event")).toBeTrue();
    expect((await apiStatus(h, "GET", "/api/approvals")).status).toBe(404);
    expect((await apiStatus(h, "POST", `/api/turns/${sent.turnId}/abort`)).status).toBe(404);
  });
});

describe("integration: threads API", () => {
  test("list threads for a bot recent-first and filter by q", async () => {
    const botId = await makeBot(h, "Lister");
    const one = await sendToBot(h, botId, "say: apple pie recipe");
    await waitThreadIdle(h, one.threadId);
    const two = await sendToBot(h, botId, "say: banana split");
    await waitThreadIdle(h, two.threadId);
    const all = await api<{ id: string; title: string }[]>(h, "GET", `/api/bots/${botId}/threads`);
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe(two.threadId); // most recent first
    const filtered = await api<{ id: string }[]>(h, "GET", `/api/bots/${botId}/threads?q=apple`);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.id).toBe(one.threadId);
  });

  test("thread rename is rejected with a 409 naming the agent", async () => {
    const botId = await makeBot(h, "Renamer");
    const sent = await sendToBot(h, botId, "say: rename me");
    await waitThreadIdle(h, sent.threadId);
    const res = await apiStatus(h, "PATCH", `/api/threads/${sent.threadId}`, { title: "Nope" });
    expect(res.status).toBe(409);
    expect((res.body as { error?: string }).error).toContain("pi");
  });
});
