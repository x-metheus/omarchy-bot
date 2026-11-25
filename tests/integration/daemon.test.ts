import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("integration: agents API", () => {
  test("lists all nine agents with version/status/reason/guidance fields", async () => {
    const agents = await api<{ id: string; displayName: string; version: string; status: string; reason?: string; guidance?: string }[]>(h, "GET", "/api/agents");
    expect(agents.length).toBe(9);
    const ids = agents.map((a) => a.id);
    for (const expected of ["pi", "omp", "codex", "claude", "grok", "opencode", "gemini", "copilot", "crush"]) {
      expect(ids).toContain(expected);
    }
    for (const agent of agents) {
      expect(agent.displayName).toBeString();
      expect(agent.version).toBeString();
      expect(agent.status).toBe("missing");
      expect(agent.reason).toBeString();
      expect(agent.guidance).toBeString();
    }
  });

  test("rechecking an Agent clears historical readiness", async () => {
    h.svc.db.query("UPDATE agents SET status = 'ready' WHERE id = 'pi'").run();
    const agent = await api<{ status: string; capabilities?: unknown }>(h, "POST", "/api/agents/pi/recheck");
    expect(agent.status).toBe("missing");
    expect(agent.capabilities).toBeUndefined();
    expect(h.svc.agents.status("pi")).toBe("missing");
  });
});

describe("integration: bots API", () => {
  test("creates bots with pi when given a different recognized agent", async () => {
    const res = await apiStatus(h, "POST", "/api/bots", { name: "Nope", instructions: "", agentId: "claude" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agentId: "pi" });
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

  test("a completed Turn keeps its Tool Call and Response separate with no pending approvals or public abort", async () => {
    const botId = await makeBot(h, "Tool and Response Bot");
    const sent = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, sent.threadId);

    const thread = await api<{ latestTurn?: { id: string; status: string } }>(h, "GET", `/api/threads/${sent.threadId}`);
    expect(thread.latestTurn).toEqual(expect.objectContaining({ id: sent.turnId, status: "completed" }));
    const rows = (await messages(sent.threadId)).filter(({ kind }) => kind === "tool" || kind === "response");
    expect(rows.map(({ kind, threadId, text, toolCall }) => ({ kind, threadId, text, toolStatus: toolCall?.status }))).toEqual([
      { kind: "tool", threadId: sent.threadId, text: undefined, toolStatus: "completed" },
      { kind: "response", threadId: sent.threadId, text: "tool finished", toolStatus: undefined },
    ]);
    const [tool, response] = rows;
    expect(tool!.id).not.toEqual(response!.id);
    expect(tool!.seq).toBeLessThan(response!.seq);

    const approvals = await apiStatus(h, "GET", "/api/approvals");
    const abort = await apiStatus(h, "POST", `/api/turns/${sent.turnId}/abort`);
    expect({ approvals, abortStatus: abort.status }).toEqual({ approvals: { status: 200, body: [] }, abortStatus: 404 });
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
