/**
 * Pi Agent conformance suite (agents-integration.md §6, eleven steps) — the Gate 1
 * gatekeeper. Runs against the REAL Pi worker (real model calls via the user's
 * Pi credentials) and the REAL computer worker. On success it writes a private
 * versioned conformance record that verifies the fixture Pi Agent is `ready`.
 *
 *   1. temp cwd + session            6. attachments (text file + 1×1 PNG)
 *   2. streamed fixed text           7. close → resume → history
 *   3. read-only tool lifecycle      8. worker exit leaves no orphans
 *   4. native write tool lifecycle    9. capability inventory / event mapping
 *   5. mid-turn cancel + steer      10. Real Pi computer tool via owning Broker
 *  11. Real Pi browser form via refs and page result
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerClient } from "../../apps/daemon/src/supervision/workerClient.ts";
import { isAgentCapabilityInventory } from "../../packages/agent-contract/src/agent-protocol.ts";
import { RED_PIXEL_PNG, startBrowserConformanceFixture, startConformanceDaemon, type ConformanceDaemon } from "./helpers.ts";
import { normalizeSessionEvent } from "../../workers/pi/src/normalize.ts";
import type { SurfaceId } from "../../packages/domain/src/index.ts";

let daemon: ConformanceDaemon;
let pi: WorkerClient;
let conformanceBot!: { id: string; surfaceId: SurfaceId };
const events: { type: string; event: Record<string, unknown> }[] = [];
const seenEventTypes = new Set<string>();
const tempDirs: string[] = [];

beforeAll(async () => {
  daemon = await startConformanceDaemon();
  pi = new WorkerClient({
    name: "agent:pi",
    script: path.resolve(import.meta.dir, "../../workers/pi/src/worker.ts"),
    env: daemon.agentEnv,
    onEvent: (event: { type: string }) => {
      events.push({ type: event.type, event: event as unknown as Record<string, unknown> });
      seenEventTypes.add(event.type);
    },
  });
  await pi.start();
}, 30_000);

afterAll(async () => {
  await pi?.stop().catch(() => {});
  await daemon?.stop();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  // Gate 1 step 8: no orphan worker processes remain.
  const proc = Bun.spawn(["pgrep", "-P", String(process.pid), "-fa", "worker.ts"]);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const stragglers = out.split("\n").filter((l) => l.includes("omarchy-bot/workers"));
  expect(stragglers).toEqual([]);
}, 20_000);

/** Drive one turn and collect streamed output. */
async function send(sessionId: string, text: string, attachments?: { id: string; name: string; path: string; mediaType: string }[]): Promise<number> {
  const before = events.length;
  const turnId = crypto.randomUUID();
  const acceptance = await pi.request({
    type: "message.send",
    requestId: crypto.randomUUID(),
    sessionId,
    turnId,
    message: { text, ...(attachments ? { attachments } : {}) },
    computer: {
      botId: conformanceBot.id,
      turnId,
      workerSessionId: sessionId,
      surfaceId: conformanceBot.surfaceId,
    },
  }, 15_000);
  expect(acceptance).toEqual({ accepted: true });
  return before;
}

async function waitForEvent(before: number, pred: (e: { type: string; event: Record<string, unknown> }) => boolean, timeoutMs: number): Promise<{ type: string; event: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.slice(before).find(pred);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for event (have: ${events.slice(before).map((e) => e.type).join(",")})`);
    await Bun.sleep(150);
  }
}

async function awaitTerminal(before: number, timeoutMs: number): Promise<{ type: string; event: Record<string, unknown> }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const recent = events.slice(before);
    if (recent.some((e) => e.type === "turn.completed" || e.type === "turn.cancelled" || e.type === "error")) {
      return recent;
    }
    if (Date.now() > deadline) throw new Error(`turn did not finish (events: ${recent.map((e) => e.type).join(",")})`);
    await Bun.sleep(150);
  }
}

async function turn(sessionId: string, text: string, opts: { attachments?: { id: string; name: string; path: string; mediaType: string }[]; timeoutMs?: number } = {}) {
  const before = await send(sessionId, text, opts.attachments);
  return awaitTerminal(before, opts.timeoutMs ?? 120_000);
}

function assistantText(recent: { type: string; event: Record<string, unknown> }[]): string {
  let text = "";
  for (const e of recent) {
    if (e.type === "response.delta" && typeof e.event.text === "string") text += e.event.text;
  }
  return text;
}

async function browserConformance(botId: string) {
  const fixture = startBrowserConformanceFixture();
  const browserCalls = spyOn(daemon.svc.computer, "agentBrowserAct");
  try {
    const sent = await daemon.svc.turns.send(botId, null, [
      "This is a browser conformance check. Use only the browser tool.",
      `Navigate to ${fixture.url}, then take a snapshot.`,
      `Use the snapshot's ref for the Conformance message textbox to type ${fixture.value}.`,
      "Use the snapshot's ref for the Submit form button to click it (take another snapshot if refs are stale).",
      "Wait for Form submitted, then call read_text to read the page result.",
      "Reply with the exact BROWSER-RECEIPT value from the returned page text. Do not use shell, fetch, scripts or any other tools.",
    ].join(" "));
    const terminal = await daemon.svc.turns.waitForTerminal(sent.turnId, 180_000);
    expect(terminal.status).toBe("completed");
    const response = await fetch(`${daemon.baseUrl}/api/threads/${sent.threadId}/messages`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(response.ok).toBeTrue();
    const transcript = await response.json() as Array<{
      kind: string;
      text?: string;
      toolCall?: { name: string; status: string };
    }>;
    const calls = transcript.filter(message => message.kind === "tool");
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.every(message => message.toolCall?.name === "browser" && message.toolCall.status === "completed")).toBeTrue();
    expect(fixture.submissions).toEqual([fixture.value]);
    expect(transcript.some(message => message.kind !== "tool" && message.text?.includes(fixture.receipt))).toBeTrue();
    const actions = browserCalls.mock.calls.map(call => call[3]);
    expect(actions.map(action => action.name)).toEqual(expect.arrayContaining(["navigate", "snapshot", "type", "click", "read_text"]));
    const typed = actions.find(action => action.name === "type");
    expect(typed?.args.text).toBe(fixture.value);
    expect(typeof typed?.args.ref).toBe("string");
    expect(actions.filter(action => action.name === "click").every(action => typeof action.args.ref === "string")).toBeTrue();
    console.log("conformance: step 11 ok — real Pi browser snapshot, form refs and page receipt");
  } finally {
    browserCalls.mockRestore();
    await fixture.stop();
  }
}

test.skipIf(process.env.OMARCHY_BOT_PI_CONFORMANCE_STEP !== "browser")("pi conformance step 11: browser form (real model)", async () => {
  const probe = await pi.request({ type: "probe", requestId: crypto.randomUUID() }, 30_000);
  if (typeof probe?.agentVersion !== "string" || !probe.agentVersion) throw new Error("Pi probe returned no agent version");
  const directory = path.join(daemon.home, "conformance");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `pi-${probe.agentVersion}.json`), JSON.stringify({ ok: true, image: "provider-unsupported" }));
  expect((await daemon.svc.agents.recheck("pi")).status).toBe("ready");
  const bot = daemon.svc.bots.create({ name: "Pi Browser Conformance", agentId: "pi", instructions: "Follow the requested browser conformance tool calls exactly." });
  await browserConformance(bot.id);
}, 210_000);

describe("pi conformance (11 steps, real model)", () => {
  test.skipIf(process.env.OMARCHY_BOT_PI_CONFORMANCE_STEP === "browser")(
    "all eleven steps pass",
    async () => {
      // ---- Step 1: temp cwd + session ----
      const version = await pi.request({ type: "probe", requestId: crypto.randomUUID() }, 30_000);
      const agentVersion = version?.agentVersion;
      if (typeof agentVersion !== "string" || agentVersion.length === 0) {
        throw new Error("Pi probe returned no agent version");
      }
      const testConfDir = path.join(daemon.home, "conformance");
      mkdirSync(testConfDir, { recursive: true });
      writeFileSync(
        path.join(testConfDir, `pi-${agentVersion}.json`),
        JSON.stringify({ ok: true, image: "provider-unsupported" }),
      );
      expect((await daemon.svc.agents.recheck("pi")).status).toBe("ready");
      conformanceBot = daemon.svc.bots.create({
        name: "Pi Conformance",
        agentId: "pi",
        instructions: "When explicitly asked for computer conformance, follow the requested computer tool calls exactly.",
      });

      const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-conform-"));
      tempDirs.push(cwd);
      const opened = (await pi.request({ type: "session.open", requestId: crypto.randomUUID(), botId: conformanceBot.id, threadId: "thread_conformance", options: { cwd, instructions: "" } }, 30_000)) as {
        sessionId: string;
        nativeSessionId: string;
      };
      expect(opened.sessionId).toBeTruthy();
      expect(opened.nativeSessionId).toBeTruthy();

      // Ordinary sends require only their existing Computer binding. If a
      // Bot-message binding is supplied, however, it must remain immutable.
      const forgedBindingTurnId = crypto.randomUUID();
      await expect(pi.request({
        type: "message.send",
        requestId: crypto.randomUUID(),
        sessionId: opened.sessionId,
        turnId: forgedBindingTurnId,
        message: { text: "This forged Bot-message binding must not start a Turn." },
        computer: {
          botId: conformanceBot.id,
          turnId: forgedBindingTurnId,
          workerSessionId: opened.sessionId,
          surfaceId: conformanceBot.surfaceId,
        },
        botMessage: {
          botId: conformanceBot.id,
          turnId: crypto.randomUUID(),
          workerSessionId: opened.sessionId,
        },
      }, 15_000)).rejects.toThrow(
        "Bot message binding is required and must match the Agent command",
      );
      console.log("conformance: step 1 ok — session", opened.nativeSessionId);

      // ---- Step 2: streamed fixed text ----
      const sayRecent = await turn(opened.sessionId, "Reply with exactly: CONFORM-STREAM-OK and nothing else.");
      const streamed = assistantText(sayRecent);
      expect(streamed).toContain("CONFORM-STREAM-OK");
      const deltaCount = sayRecent.filter((e) => e.type === "response.delta").length;
      expect(deltaCount).toBeGreaterThanOrEqual(1);
      expect(sayRecent.some((e) => e.type === "turn.completed")).toBeTrue();
      console.log(`conformance: step 2 ok — streamed in ${deltaCount} deltas`);

      // ---- Step 3: read-only native tool lifecycle ----
      const roFile = path.join(cwd, "conform-readonly.txt");
      writeFileSync(roFile, "READ-ONLY-CONFORM");
      const lsRecent = await turn(opened.sessionId, `Use the read tool (NOT bash) to read the file ${roFile}, then reply DONE.`);
      expect(lsRecent.some((e) => e.type === "tool.started" && (e.event as { name?: string }).name === "read")).toBeTrue();
      const lsDone = lsRecent.find((e) => e.type === "tool.completed");
      expect(lsDone).toBeDefined();
      expect(lsDone!.event.status).toBe("completed");
      console.log("conformance: step 3 ok — read-only native tool lifecycle");

      // ---- Step 4: native write tool lifecycle under Pi's own behavior ----
      const target = path.join(cwd, "conform-write-test.txt");
      const writeRecent = await turn(
        opened.sessionId,
        `Use the write tool to create a file at exactly ${target} containing the single word OK.`,
        { timeoutMs: 180_000 },
      );
      expect(writeRecent.some((e) => e.type === "tool.started" && (e.event as { name?: string }).name === "write")).toBeTrue();
      expect(writeRecent.some((e) => e.type === "tool.completed" && e.event.status === "completed")).toBeTrue();
      expect(writeRecent.some((e) => e.type === "turn.completed")).toBeTrue();
      const deadline4 = Date.now() + 30_000;
      while (!existsSync(target) && Date.now() < deadline4) await Bun.sleep(200);
      expect((await Bun.file(target).text()).trim()).toBe("OK");
      console.log("conformance: step 4 ok — native write tool completed");

      // ---- Step 5: cancel mid-turn; no late writes after cancel ----
      // Dedicated session: an aborted run must never pollute later turns.
      const countSession = (await pi.request({ type: "session.open", requestId: crypto.randomUUID(), botId: conformanceBot.id, threadId: "thread_conformance_count", options: { cwd, instructions: "" } }, 30_000)) as { sessionId: string };
      const before = await send(countSession.sessionId, "Count from 1 to 400, one number per line, no commentary.");
      const deadline5 = Date.now() + 60_000;
      let sawDeltas = 0;
      while (Date.now() < deadline5) {
        sawDeltas = events.slice(before).filter((e) => e.type === "response.delta").length;
        if (sawDeltas >= 5) break;
        await Bun.sleep(150);
      }
      expect(sawDeltas).toBeGreaterThanOrEqual(5);
      await pi.request({ type: "turn.abort", requestId: crypto.randomUUID(), sessionId: countSession.sessionId }, 30_000);
      const cancelled = events.slice(before).find((e) => e.type === "turn.cancelled");
      expect(cancelled).toBeDefined();
      await Bun.sleep(2500); // settle window: nothing may land after cancel
      const cancelledIndex = events.findIndex((event) => event === cancelled);
      const lateWrites = events
        .slice(cancelledIndex + 1)
        .filter((event) => event.type === "tool.started" || event.type === "response.delta");
      expect(lateWrites).toEqual([]);
      console.log("conformance: step 5 ok — cancelled mid-turn, no late writes");

      // ---- Step 5b: native steer keeps the active session and completes ----
      const steerSession = (await pi.request({
        type: "session.open",
        requestId: crypto.randomUUID(),
        botId: conformanceBot.id,
        threadId: "thread_conformance_steer",
        options: { cwd, instructions: "" },
      }, 30_000)) as { sessionId: string; nativeSessionId: string };
      const steerBefore = await send(
        steerSession.sessionId,
        "Count from 1 to 1000, one number per line, no commentary.",
      );
      await waitForEvent(
        steerBefore,
        (event) => event.type === "response.delta" && event.event.sessionId === steerSession.sessionId,
        60_000,
      );
      const steerResult = await pi.request({
        type: "message.steer",
        requestId: crypto.randomUUID(),
        sessionId: steerSession.sessionId,
        text: "Change course now. Stop counting and reply exactly STEER-NATIVE-OK.",
      }, 30_000) as { steered: boolean };
      expect(steerResult.steered).toBeTrue();
      const steeredRecent = (await awaitTerminal(steerBefore, 120_000))
        .filter((event) => event.event.sessionId === steerSession.sessionId);
      expect(steeredRecent.some((event) => event.type === "turn.completed")).toBeTrue();
      expect(steeredRecent.some((event) => event.type === "turn.cancelled")).toBeFalse();
      expect(steeredRecent.every((event) => event.event.sessionId === steerSession.sessionId)).toBeTrue();
      expect(assistantText(steeredRecent)).toContain("STEER-NATIVE-OK");
      console.log(`conformance: step 5b ok — native steer completed in session ${steerSession.nativeSessionId}`);

      // ---- Step 6: attachments (text file + 1×1 PNG) ----
      const textPath = path.join(cwd, "secret.txt");
      writeFileSync(textPath, "The secret phrase is CONFORM-TEXT-42.");
      const pngPath = path.join(cwd, "red.png");
      writeFileSync(pngPath, RED_PIXEL_PNG);
      // Capabilities are global to normal Bot turns, so image support must be
      // exercised through the same default-model session path used in production.
      let imageResult: "ok" | "provider-unsupported" = "provider-unsupported";
      let imageNote = "default model did not identify the image";
      let attachReply = "";
      try {
        const imageSession = (await pi.request({
          type: "session.open",
          requestId: crypto.randomUUID(),
          botId: conformanceBot.id,
          threadId: "thread_conformance_vision",
          options: { cwd, instructions: "" },
        }, 30_000)) as { sessionId: string };
        const recent = await turn(
          imageSession.sessionId,
          "A text attachment contains a secret phrase and an image attachment is solid red. Reply in one line: the secret phrase, then the color word.",
          {
            attachments: [
              { id: "a1", name: "secret.txt", path: textPath, mediaType: "text/plain" },
              { id: "a2", name: "red.png", path: pngPath, mediaType: "image/png" },
            ],
          },
        );
        attachReply = assistantText(recent);
        if (attachReply.includes("CONFORM-TEXT-42") && /\bred\b/i.test(attachReply)) {
          imageResult = "ok";
          imageNote = "default model identified the solid red image";
        }
      } catch (error) {
        imageNote = `default model rejected image input: ${error instanceof Error ? error.message : String(error)}`;
      }
      const textAttachRecent = attachReply.includes("CONFORM-TEXT-42")
        ? null
        : await (async () => {
            const ts = (await pi.request({ type: "session.open", requestId: crypto.randomUUID(), botId: conformanceBot.id, threadId: "thread_conformance_text", options: { cwd, instructions: "" } }, 30_000)) as { sessionId: string };
            return turn(ts.sessionId, "The attachment names a secret phrase. Reply with just the secret phrase.", { attachments: [{ id: "a1", name: "secret.txt", path: textPath, mediaType: "text/plain" }] });
          })();
      if (textAttachRecent) attachReply = assistantText(textAttachRecent);
      expect(attachReply).toContain("CONFORM-TEXT-42");
      console.log(`conformance: step 6 ok — text attachment ok; image: ${imageResult} (${imageNote})`);

      // ---- Step 7: close → resume → history ----
      await pi.request({ type: "session.close", requestId: crypto.randomUUID(), sessionId: opened.sessionId }, 15_000);
      const resumed = (await pi.request(
        { type: "session.resume", requestId: crypto.randomUUID(), botId: conformanceBot.id, threadId: "thread_conformance", nativeSessionId: opened.nativeSessionId, options: { cwd, instructions: "" } },
        30_000,
      )) as { sessionId: string };
      const history = (await pi.request({ type: "session.history", requestId: crypto.randomUUID(), sessionId: resumed.sessionId }, 30_000)) as {
        messages: { role: string; text?: string }[];
      };
      const roles = history.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      const allText = history.messages.map((m) => m.text ?? "").join("\n");
      expect(allText).toContain("CONFORM-STREAM-OK");
      console.log(`conformance: step 7 ok — resumed native session, ${history.messages.length} history messages`);

      // ---- Step 8: worker exit leaves no orphans (asserted in afterAll pgrep) ----
      // Kill this worker abruptly; supervisor semantics are exercised by the
      // integration suite. Here we verify a fresh client takes over cleanly.
      await pi.stop().catch(() => {});
      pi = new WorkerClient({
        name: "agent:pi",
        script: path.resolve(import.meta.dir, "../../workers/pi/src/worker.ts"),
        env: daemon.agentEnv,
        onEvent: (event: { type: string }) => {
          events.push({ type: event.type, event: event as unknown as Record<string, unknown> });
          seenEventTypes.add(event.type);
        },
      });
      await pi.start();
      const reprobe = await pi.request({ type: "probe", requestId: crypto.randomUUID() }, 30_000);
      const probePayload: unknown = reprobe;
      if (probePayload === null || typeof probePayload !== "object" || !("sdkOk" in probePayload) || !("capabilities" in probePayload)) {
        throw new Error("Pi probe returned an invalid payload");
      }
      expect(probePayload.sdkOk).toBeTrue();
      if (!isAgentCapabilityInventory(probePayload.capabilities)) {
        throw new Error("Pi probe returned an invalid capability inventory");
      }
      const capabilities = probePayload.capabilities;
      expect(capabilities).toMatchObject({
        version: 4,
        steering: true,
        abort: true,
        botMail: true,
        plugins: true,
        nativeThreadActions: ["resume", "history", "close"],
        attachments: { text: true, maxTextBytes: 64 * 1024 },
        nativeEventFamilies: [],
      });
      expect(capabilities.thinking.streaming).toBe(capabilities.thinking.supported);
      expect(Object.keys(capabilities ?? {}).sort()).toEqual([
        "abort",
        "attachments",
        "botMail",
        "nativeEventFamilies",
        "nativeThreadActions",
        "plugins",
        "steering",
        "thinking",
        "version",
      ]);
      await expect(
        pi.request({ type: "session.delete", nativeSessionId: "obsolete" }, 5_000),
      ).rejects.toThrow("unsupported command");
      console.log("conformance: step 8 ok — worker restart clean (orphans checked in afterAll)");

      // ---- Step 9: capability inventory / event mapping ----
      // Pi does not emit progress updates for every tool (fast read/write tools
      // commonly jump from start to end), so require only live lifecycle
      // boundaries here and exercise the optional update mapping directly.
      const REQUIRED_LIVE_EVENT_TYPES = ["response.start", "response.delta", "response.end", "tool.started", "tool.completed", "turn.completed", "turn.cancelled"] as const;
      for (const t of REQUIRED_LIVE_EVENT_TYPES) {
        expect(seenEventTypes.has(t), `missing live event type ${t}; saw ${[...seenEventTypes].sort().join(", ")}`).toBeTrue();
      }
      const toolTracker = {
        responseBlockIds: new Map<number, string>(),
        thinkingBlocks: new Map<number, { blockId: string; text: string }>(),
        toolCalls: new Map<string, { name: string; startedAt: number }>(),
      };
      normalizeSessionEvent({
        type: "tool_execution_start",
        toolCallId: "tool_conformance",
        toolName: "read",
        args: { secret: "must-not-cross" },
      }, "session_conformance", toolTracker);
      expect(normalizeSessionEvent({
        type: "tool_execution_update",
        toolCallId: "tool_conformance",
        partialResult: { content: [{ type: "text", text: "partial output" }] },
      }, "session_conformance", toolTracker)).toEqual([{
        type: "tool.updated",
        sessionId: "session_conformance",
        id: "tool_conformance",
        name: "read",
        status: "running",
      }]);
      console.log(`conformance: step 9 ok — normalized event inventory mapped: ${[...seenEventTypes].sort().join(", ")}`);

      // ---- Step 10: REAL Pi SDK custom tool -> daemon -> owning Broker/worker ----
      // Seed only the isolated daemon's gate so its supervised Pi worker can run
      // these final live conformance turns.
      const image = imageResult === "ok" ? "verified" : "provider-unsupported";
      const record = JSON.stringify({ ok: true, at: new Date().toISOString(), steps: 11, image });
      writeFileSync(path.join(testConfDir, `pi-${agentVersion}.json`), JSON.stringify({ ok: true, image }));
      expect((await daemon.svc.agents.recheck("pi")).status).toBe("ready");
      const sent = await daemon.svc.turns.send(
        conformanceBot.id,
        null,
        [
          "This is a computer conformance check.",
          "Use only the computer tool and invoke it exactly twice.",
          "First call action \"type\" with args {\"text\":\"PI-BOT-SCREEN-VISIBLE\"}.",
          "Then call action \"screenshot\" with empty args.",
          "After both calls succeed, reply PI-COMPUTER-TOOL-OK.",
        ].join(" "),
      );
      const terminal = await daemon.svc.turns.waitForTerminal(sent.turnId, 180_000);
      expect(terminal.status).toBe("completed");
      const transcript = await fetch(
        `${daemon.baseUrl}/api/threads/${sent.threadId}/messages`,
        { headers: { authorization: `Bearer ${daemon.token}` } },
      ).then((response) => response.json()) as Array<{
        kind: string;
        text?: string;
        payload?: unknown;
        toolCall?: {
          id: string;
          name: string;
          status: string;
          durationMs?: number;
        };
      }>;
      const computerCalls = transcript.filter((message) =>
        message.kind === "tool"
        && message.toolCall?.name === "computer"
        && message.toolCall.status === "completed"
      );
      expect(computerCalls).toHaveLength(2);
      expect(computerCalls.every((message) => message.payload === undefined)).toBeTrue();
      expect(
        transcript.some((message) => message.text?.includes("PI-COMPUTER-TOOL-OK")),
      ).toBeTrue();
      expect(daemon.svc.computer.state({
        botId: conformanceBot.id,
        surfaceId: conformanceBot.surfaceId,
      }).lastImageAt).toBeDefined();
      console.log("conformance: step 10 ok — real Pi custom tool typed and observed its owning Bot Screen");

      // ---- Step 11: REAL Pi browser snapshot -> refs -> submitted page text ----
      await browserConformance(conformanceBot.id);

      // ---- Record: write the versioned conformance record and verify the gate ----
      const recordPath = path.join(testConfDir, `pi-${agentVersion}.json`);
      writeFileSync(recordPath, record);
      console.log(`conformance: record written ${recordPath}`);
      const sessionsDir = path.join(os.homedir(), ".pi/agent/sessions");
      const sessionFiles = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".jsonl"));
      expect(sessionFiles.length).toBeGreaterThanOrEqual(5);
      expect(opened.nativeSessionId.startsWith(`${sessionsDir}/`)).toBeTrue();
      expect(existsSync(opened.nativeSessionId)).toBeTrue();
      expect(recordPath.startsWith(`${os.homedir()}/`)).toBeTrue();
      console.log(`conformance: ${sessionFiles.length} native session files confined to ${sessionsDir}`);
      const agent = await daemon.svc.agents.recheck("pi");
      expect(agent.status).toBe("ready");
      console.log("conformance: Pi Agent is READY");
    },
    810_000,
  );
});
