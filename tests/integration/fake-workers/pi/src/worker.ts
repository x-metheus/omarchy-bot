/**
 * Scripted fake agent worker for integration tests. Speaks the LF-JSONL
 * worker protocol v2 from packages/agent-contract and behaves according to
 * directives embedded in the message text:
 *
 *   say: <text>      streams one ordered Response Block, then turn.completed
 *   tool             emits Tool Calls plus a residual Native Event
 *   hang             streams an incomplete Response Block and waits for turn.abort; steering
 *                    during hang returns an error (failure path is testable)
 *   steer-echo       long atomic tool action; message.steer is acknowledged
 *                    immediately, applied after tool.completed, then completes
 *   ordered-transcript emits a mixed rich Turn and pauses at a real Steering boundary
 *   process-only     completes with Thinking, Tool, and Native Event records but no Response
 *   attachment-echo validates the daemon's managed worker paths and echoes metadata/content
 *   computer:<action> invokes the daemon-owned Bot Screen tool bridge
 *   local.run:<command> invokes the daemon-owned Local Sidecar tool bridge
 *
 *   send_bot_message:<targetBotId>:<text>[:retry] invokes the daemon-owned mailbox bridge;
 *                    :retry re-sends the same Tool Call, which the channel must refuse
 *   send_bot_message_after_release:<file>:<targetBotId>:<text> delays that bridge for readiness tests
 * Stays alive until stdin closes (daemon lifecycle contract).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_CAPABILITY_INVENTORY_VERSION,
  redactToolErrorSummary,
  type AgentCapabilityInventory,
  type ProbePayload,
} from "../../../../../packages/agent-contract/src/agent-protocol.ts";
import {
  createToolChannelWorker,
  type ToolChannelFrame,
} from "../../../../../packages/agent-contract/src/tool-channel.ts";
import { readJsonl } from "../../../../../packages/agent-contract/src/framing.ts";

const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
let responseCounter = 0;
function emitResponse(sessionId: string, turnId: string, text: string, complete = true): string {
  const blockId = `fake-response-${turnId}-${++responseCounter}`;
  write({
    type: "event",
    event: { type: "response.start", sessionId, blockId, startedAt: new Date().toISOString() },
  });
  if (text.length > 0) {
    write({ type: "event", event: { type: "response.delta", sessionId, blockId, text } });
  }
  if (complete) {
    write({
      type: "event",
      event: { type: "response.end", sessionId, blockId, completedAt: new Date().toISOString() },
    });
  }
  return blockId;
}
let thinkingCounter = 0;
function emitThinking(
  sessionId: string,
  turnId: string,
  text: string,
  options: { complete?: boolean; durationMs?: number } = {},
): string {
  const blockId = `fake-thinking-${turnId}-${++thinkingCounter}`;
  const completedAt = Date.now();
  write({
    type: "event",
    event: {
      type: "thinking.start",
      sessionId,
      blockId,
      startedAt: new Date(completedAt - (options.durationMs ?? 0)).toISOString(),
    },
  });
  if (text.length > 0) {
    write({ type: "event", event: { type: "thinking.delta", sessionId, blockId, text } });
  }
  if (options.complete !== false) {
    write({
      type: "event",
      event: { type: "thinking.end", sessionId, blockId, completedAt: new Date(completedAt).toISOString() },
    });
  }
  return blockId;
}



const AGENT_ID = process.env.OMARCHY_BOT_FAKE_AGENT_ID === "omp" ? "omp" : "pi";
write({ type: "hello", v: 1, worker: `agent:${AGENT_ID}`, pid: process.pid });
const heartbeat = setInterval(() => write({ type: "heartbeat" }), 5_000);
heartbeat.unref?.();
const workerHome = dataDir();
if (workerHome !== undefined) {
  appendFileSync(path.join(workerHome, "fake-agent-worker-starts.log"), `${process.pid}\n`);
}

const nativeSessionLog = workerHome === undefined
  ? undefined
  : path.join(workerHome, `fake-agent-${AGENT_ID}-native-sessions.log`);
const nativeSessions = new Set(
  nativeSessionLog !== undefined && existsSync(nativeSessionLog)
    ? readFileSync(nativeSessionLog, "utf8").split("\n").filter((id) => id.length > 0)
    : [],
);

function rememberNativeSession(nativeSessionId: string): void {
  if (nativeSessions.has(nativeSessionId)) return;
  nativeSessions.add(nativeSessionId);
  if (nativeSessionLog !== undefined) appendFileSync(nativeSessionLog, `${nativeSessionId}\n`);
}

const AGENT_VERSION = `fake-${AGENT_ID}-1`;

interface FakeProbeControl {
  ok?: unknown;
  image?: unknown;
  fakeProbe?: "invalid" | "offline";
  fakeCapabilities?: {
    steering?: boolean;
    abort?: boolean;
    botMail?: boolean;
    nativeThreadActions?: Array<"resume" | "history" | "close" | "rename" | "delete" | "fork" | "compact">;
    thinking?: {
      supported: boolean;
      streaming: boolean;
    };
    nativeEventFamilies?: string[];
  };
  fakeAbortBehavior?: "fail_once" | "ignore_once";
  fakeAbortReleaseFile?: string;
}

function dataDir(): string | undefined {
  return process.env.OMARCHY_BOT_HOME;
}

function probeControl(): FakeProbeControl {
  try {
    const root = dataDir();
    if (root === undefined) return {};
    return JSON.parse(readFileSync(path.join(root, "conformance", `${AGENT_ID}-${AGENT_VERSION}.json`), "utf8")) as FakeProbeControl;
  } catch {
    return {};
  }
}

function capabilitiesFor(control: FakeProbeControl): AgentCapabilityInventory {
  const thinkingSupported = control.fakeCapabilities?.thinking?.supported ?? true;
  return {
    version: AGENT_CAPABILITY_INVENTORY_VERSION,
    steering: control.fakeCapabilities?.steering ?? true,
    abort: control.fakeCapabilities?.abort ?? true,
    botMail: control.fakeCapabilities?.botMail ?? true,
    plugins: false,
    nativeThreadActions: control.fakeCapabilities?.nativeThreadActions ?? ["resume", "history", "close"],
    thinking: {
      supported: thinkingSupported,
      streaming: thinkingSupported && (control.fakeCapabilities?.thinking?.streaming ?? true),
    },
    attachments: { text: true, image: control.ok === true && control.image === "verified" },
    nativeEventFamilies: control.fakeCapabilities?.nativeEventFamilies ?? [
      "fake.progress",
      "fake.diagnostic-progress",
      "fake.secret-progress",
    ],
  };
}

let currentCapabilities = capabilitiesFor(probeControl());

function recordCommand(command: "message.steer" | "turn.abort"): void {
  const root = dataDir();
  if (root !== undefined) appendFileSync(path.join(root, "fake-worker-commands.log"), `${command}\n`);
}

function recordObservation(observation: Record<string, unknown>): void {
  const root = dataDir();
  if (root !== undefined) {
    appendFileSync(
      path.join(root, "fake-agent-observations.ndjson"),
      `${JSON.stringify(observation)}\n`,
    );
  }
}

let sessionCounter = nativeSessions.size;
interface FakeAttachment {
  id: string;
  name: string;
  path: string;
  mediaType: string;
}

interface ComputerTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
  surfaceId: string;
}

interface BotMessageTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
}

interface FakeSession {
  aborted: boolean;
  streaming: boolean;
  directive?: string | undefined;
  /** One turn's tool-bridge signal: turn.abort aborts every bridge waiting on it. */
  turnAbort?: AbortController;
  /** A non-streaming bridge call (local, send_bot_message) whose Turn abort must cancel. */
  toolInFlight?: boolean;
  steerReply?: ((text: string) => void) | undefined;
}
const sessions = new Map<string, FakeSession>();
const failedOnce = new Set<string>();
const failedAbortOnce = new Set<string>();
const ignoredAbortOnce = new Set<string>();

const respond = (requestId: string, payload: unknown): void => {
  write({ requestId, ok: true, payload });
};
const respondError = (requestId: string, error: string): void => {
  write({ requestId, ok: false, error });
};

/** One ToolChannel for every daemon-owned bridge this fake worker calls. */
const toolChannel = createToolChannelWorker();
toolChannel.send = (frame) => write(frame);

function requestBotMessage(
  context: BotMessageTurnContext,
  toolCallId: string,
  targetBotId: string,
  text: string,
  signal: AbortSignal,
): Promise<{ deliveryId: string; queued: true }> {
  return toolChannel
    .call("send_bot_message", { targetBotId, text }, { ...context, toolCallId }, signal)
    .then((result) => result as { deliveryId: string; queued: true });
}

function requestComputer(
  context: ComputerTurnContext,
  toolCallId: string,
  action: { name: string; args: Record<string, unknown> },
  signal: AbortSignal,
): Promise<unknown> {
  return toolChannel.call(
    "computer",
    { action: action.name, args: action.args },
    { ...context, toolCallId },
    signal,
  );
}


function requestLocal(
  context: BotMessageTurnContext,
  toolCallId: string,
  action: "run" | "search" | "read" | "write" | "transfer",
  args: {
    target?: string;
    command?: string;
    path?: string;
    destination?: string;
    query?: string;
    contents?: string;
    direction?: "to-workspace" | "from-workspace";
  } = {},
  signal: AbortSignal,
): Promise<{ deviceId: string; hostname: string; text: string; exitCode?: number }> {
  return toolChannel
    .call("local", { action, ...args }, { ...context, toolCallId }, signal)
    .then((result) => result as { deviceId: string; hostname: string; text: string; exitCode?: number });
}

function parseLocalDirective(text: string): {
  action: "run" | "search" | "read" | "write" | "transfer";
  target?: string;
  command?: string;
  path?: string;
  destination?: string;
  query?: string;
  contents?: string;
  direction?: "to-workspace" | "from-workspace";
} | undefined {
  if (!text.startsWith("local.")) return undefined;
  const body = text.slice("local.".length);
  const at = body.match(/^(run|search|read|write|transfer)@(dev_[0-9a-f]{32}|this-device):(.*)$/);
  const plain = body.match(/^(run|search|read|write|transfer):(.*)$/);
  const matched = at ?? plain;
  if (matched === null) return undefined;
  const action = matched[1] as "run" | "search" | "read" | "write" | "transfer";
  const target = at === null ? undefined : at[2];
  const rest = at === null ? plain![2]! : at[3]!;
  if (action === "run") return { action, command: rest, ...(target !== undefined ? { target } : {}) };
  if (action === "search") return { action, query: rest, ...(target !== undefined ? { target } : {}) };
  if (action === "read") return { action, path: rest, ...(target !== undefined ? { target } : {}) };
  if (action === "write") {
    const split = rest.indexOf(":");
    const path = split < 0 ? rest : rest.slice(0, split);
    const contents = split < 0 ? "" : rest.slice(split + 1);
    return { action, path, contents, ...(target !== undefined ? { target } : {}) };
  }
  const parts = rest.split(":");
  const direction = parts[0] === "from-workspace" ? "from-workspace" as const : "to-workspace" as const;
  return {
    action,
    direction,
    path: parts[1] ?? "",
    destination: parts.slice(2).join(":"),
    ...(target !== undefined ? { target } : {}),
  };
}

function computerTurnContext(value: unknown): ComputerTurnContext | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (
    !("botId" in value)
    || !("turnId" in value)
    || !("workerSessionId" in value)
    || !("surfaceId" in value)
    || typeof value.botId !== "string"
    || typeof value.turnId !== "string"
    || typeof value.workerSessionId !== "string"
    || typeof value.surfaceId !== "string"
  ) {
    return undefined;
  }
  return {
    botId: value.botId,
    turnId: value.turnId,
    workerSessionId: value.workerSessionId,
    surfaceId: value.surfaceId,
  };
}

function botMessageTurnContext(value: unknown): BotMessageTurnContext | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (
    !("botId" in value)
    || !("turnId" in value)
    || !("workerSessionId" in value)
    || typeof value.botId !== "string"
    || typeof value.turnId !== "string"
    || typeof value.workerSessionId !== "string"
  ) {
    return undefined;
  }
  return {
    botId: value.botId,
    turnId: value.turnId,
    workerSessionId: value.workerSessionId,
  };
}

readJsonl(Bun.stdin.stream(), (raw) => {
  const msg = raw as Record<string, unknown> & { type: string; requestId?: string };
  switch (msg.type) {
    // Relay an inbound tool.request the worker did not originate, so a test can
    // inject a duplicate frame the daemon reads back as if the worker sent it.
    case "tool.request": {
      write(msg);
      break;
    }
    case "tool.result": {
      if (msg.requestId === undefined) break;
      toolChannel.receive(msg as unknown as ToolChannelFrame);
      break;
    }
    case "probe": {
      const control = probeControl();
      if (control.fakeProbe === "offline") {
        respondError(msg.requestId!, "fake probe offline");
        break;
      }
      if (control.fakeProbe === "invalid") {
        respond(msg.requestId!, {
          agentId: AGENT_ID,
          installed: true,
          sdkOk: true,
          agentVersion: AGENT_VERSION,
          capabilities: { version: 999 },
        });
        break;
      }
      currentCapabilities = capabilitiesFor(control);
      respond(msg.requestId!, {
        agentId: AGENT_ID,
        installed: true,
        sdkOk: true,
        agentVersion: AGENT_VERSION,
        capabilities: currentCapabilities,
      } satisfies ProbePayload);
      break;
    }
    case "session.open": {
      if (
        typeof msg.options === "object"
        && msg.options !== null
        && "instructions" in msg.options
        && msg.options.instructions === "fake-session-open-failure"
      ) {
        respondError(msg.requestId!, "fake worker secret: session.open rejected");
        break;
      }
      const id = `s${++sessionCounter}`;
      const nativeSessionId = `fake://${id}`;
      sessions.set(id, { aborted: false, streaming: false });
      rememberNativeSession(nativeSessionId);
      recordObservation({
        type: msg.type,
        requestId: msg.requestId,
        botId: msg.botId,
        threadId: msg.threadId,
        options: msg.options,
        sessionId: id,
        nativeSessionId,
      });
      respond(msg.requestId!, { sessionId: id, nativeSessionId });
      break;
    }
    case "session.resume": {
      const nativeSessionId = msg.nativeSessionId;
      if (typeof nativeSessionId !== "string" || !nativeSessions.has(nativeSessionId)) {
        respondError(msg.requestId!, `native session not found: ${String(nativeSessionId)}`);
        break;
      }
      const id = `s${++sessionCounter}`;
      sessions.set(id, { aborted: false, streaming: false });
      recordObservation({
        type: msg.type,
        requestId: msg.requestId,
        botId: msg.botId,
        threadId: msg.threadId,
        options: msg.options,
        sessionId: id,
        nativeSessionId,
      });
      respond(msg.requestId!, { sessionId: id, nativeSessionId });
      break;
    }
    case "message.send": {
      const command = msg as unknown as {
        sessionId: string;
        turnId: string;
        message: { text: string; attachments?: FakeAttachment[] };
      };
      recordObservation({
        type: msg.type,
        requestId: msg.requestId,
        sessionId: command.sessionId,
        turnId: command.turnId,
        message: command.message,
        computer: msg.computer,
        botMessage: msg.botMessage,
        local: msg.local,
      });
      const { sessionId, message } = command;
      let text = message.text;
      const s = sessions.get(sessionId)!;
      s.aborted = false;
      s.directive = undefined;
      s.steerReply = undefined;
      const turnAbort = new AbortController();
      s.turnAbort = turnAbort;
      void (async () => {
        let mailboxReleasePath: string | undefined;
        if (text.startsWith("send_bot_message_after_release:")) {
          const delayed = text.slice("send_bot_message_after_release:".length);
          const separator = delayed.indexOf(":");
          const releaseFile = separator < 0 ? "" : delayed.slice(0, separator);
          const mailboxCommand = separator < 0 ? "" : delayed.slice(separator + 1);
          const root = dataDir();
          mailboxReleasePath = root === undefined || releaseFile.length === 0
            ? undefined
            : path.join(root, releaseFile);
          text = `send_bot_message:${mailboxCommand}`;
        }
        if (text.startsWith("send_bot_message:")) {
          const binding = botMessageTurnContext(msg.botMessage);
          const commandText = text.slice("send_bot_message:".length);
          const separator = commandText.indexOf(":");
          const targetBotId = separator < 0 ? "" : commandText.slice(0, separator);
          const rawBody = separator < 0 ? "" : commandText.slice(separator + 1);
          const retry = rawBody.endsWith(":retry");
          const forgeSource = rawBody.endsWith(":forge-source");
          const suffix = retry ? ":retry" : forgeSource ? ":forge-source" : "";
          const body = suffix === "" ? rawBody : rawBody.slice(0, -suffix.length);
          const toolCallId = `bot-message-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: toolCallId,
              name: "send_bot_message",
              status: "running",
              target: targetBotId,
            },
          });
          s.toolInFlight = true;
          while (mailboxReleasePath !== undefined && !existsSync(mailboxReleasePath)) {
            await Bun.sleep(10);
          }
          try {
            if (binding === undefined) throw new Error("Bot message tool binding missing");
            const requestBinding = forgeSource
              ? { ...binding, botId: targetBotId }
              : binding;
            const acknowledgements = [
              await requestBotMessage(requestBinding, toolCallId, targetBotId, body, turnAbort.signal),
            ];
            if (retry) {
              // The channel dispatches a Tool Call once, so a repeated send must be
              // refused and leave the delivery the first attempt acknowledged.
              const refusal = await requestBotMessage(binding, toolCallId, targetBotId, body, turnAbort.signal)
                .then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
              if (refusal !== "tool call was already dispatched") {
                throw new Error(`expected a refused duplicate dispatch, got ${refusal === "" ? "an acknowledgement" : refusal}`);
              }
            }
            if (mailboxReleasePath !== undefined) {
              appendFileSync(`${mailboxReleasePath}.ack`, "");
            }
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "send_bot_message",
                status: "completed",
                target: targetBotId,
              },
            });
            emitResponse(
              sessionId,
              command.turnId,
              `Bot message acknowledgements: ${acknowledgements.map(
                (acknowledgement) => `${acknowledgement.deliveryId} queued`,
              ).join("; ")}.`,
            );
            write({ type: "event", event: { type: "turn.completed", sessionId } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "send_bot_message",
                status: "error",
                target: targetBotId,
                errorSummary: redactToolErrorSummary(message),
              },
            });
            write({
              type: "event",
              event: { type: "error", sessionId, message, retryable: false },
            });
          } finally {
            s.toolInFlight = false;
          }
          respond(msg.requestId!, { accepted: true });
          return;
        }
        const peerMail =
          /^Message from Bot (.+?)(?: \((bot_[0-9a-f]{32})\))?:\n\n([\s\S]*)$/.exec(text);
        if (peerMail !== null) {
          const body = peerMail[3]!;
          respond(msg.requestId!, { accepted: true });
          if (body === "mailbox-ordered-output") {
            emitThinking(sessionId, command.turnId, "Review the isolated peer mail.", { durationMs: 25 });
            const toolCallId = `peer-mail-${command.turnId}`;
            write({
              type: "event",
              event: {
                type: "tool.started",
                sessionId,
                id: toolCallId,
                name: "read",
                status: "running",
                target: "mailbox-input",
              },
            });
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "read",
                status: "completed",
                target: "mailbox-input",
                durationMs: 4,
              },
            });
            write({
              type: "event",
              event: {
                type: "native",
                sessionId,
                agentId: AGENT_ID,
                capability: "fake.progress",
                payload: { stage: "peer-mail" },
                sensitivity: "public",
              },
            });
            emitResponse(sessionId, command.turnId, "Peer mail handled.");
            write({ type: "event", event: { type: "turn.completed", sessionId } });
            return;
          }
          if (body === "mailbox-fail-after-acceptance") {
            // The test releases this independently after observing the durable
            // accepted state, matching adapters that emit later Turn events.
            const root = dataDir();
            const release = root === undefined
              ? undefined
              : path.join(root, "fake-peer-mail-failure.release");
            while (release !== undefined && !existsSync(release)) {
              await Bun.sleep(10);
            }
            write({
              type: "event",
              event: {
                type: "error",
                sessionId,
                message: "fake peer-mail failure",
                retryable: false,
              },
            });
            return;
          }
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          return;
        }

        const localDirective = parseLocalDirective(text);
        if (localDirective !== undefined) {
          const binding = botMessageTurnContext(msg.local);
          const toolCallId = `local-${command.turnId}`;
          const safeTarget = redactToolErrorSummary(
            localDirective.command ?? localDirective.path ?? localDirective.query ?? localDirective.action,
          );
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: toolCallId,
              name: "local",
              status: "running",
              target: safeTarget,
            },
          });
          respond(msg.requestId!, { accepted: true });
          s.toolInFlight = true;
          try {
            if (binding === undefined) throw new Error("local tool binding missing");
            const { action, ...args } = localDirective;
            const result = await requestLocal(binding, toolCallId, action, args, turnAbort.signal);
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "local",
                status: "completed",
                target: `${result.hostname} ${safeTarget}`,
              },
            });
            emitResponse(sessionId, command.turnId, result.text);
            write({ type: "event", event: { type: "turn.completed", sessionId } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "local",
                status: "error",
                target: safeTarget,
                errorSummary: redactToolErrorSummary(message),
              },
            });
            write({
              type: "event",
              event: { type: "error", sessionId, message, retryable: false },
            });
          } finally {
            s.toolInFlight = false;
          }
          return;
        }
        if (text.startsWith("computer:")) {
          const binding = computerTurnContext(msg.computer);
          const parts = text.split(":");
          const toolCallId = `computer-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: toolCallId,
              name: "computer",
              status: "running",
              target: parts[1],
            },
          });
          if (parts[1] === "crash-agent") process.exit(17);
          try {
            if (binding === undefined) throw new Error("computer tool binding missing");
            const context = { ...binding };
            if (parts[2] === "mismatch") context.surfaceId = parts[3] ?? "";
            if (parts[2] === "stale") context.turnId = `stale-${context.turnId}`;
            if (parts[2] === "wrong-bot") context.botId = `wrong-${context.botId}`;
            if (parts[2] === "wrong-session") {
              context.workerSessionId = `wrong-${context.workerSessionId}`;
            }
            const requestToolCallId = parts[2] === "missing-tool-call"
              ? ""
              : toolCallId;
            const action = parts[1] === "click"
              ? { name: "click", args: { marker: parts[2] ?? "" } }
              : parts[1] === "screenshot"
                ? { name: "screenshot", args: {} }
                : {
                    name: "observe",
                    args: parts[2] === "fail" ? { fail: true } : {},
                  };
            s.streaming = true;
            const result = await requestComputer(
              context,
              requestToolCallId,
              action,
              turnAbort.signal,
            );
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "computer",
                status: "completed",
              },
            });
            emitResponse(sessionId, command.turnId, JSON.stringify(result));
            write({ type: "event", event: { type: "turn.completed", sessionId } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            write({
              type: "event",
              event: {
                type: "tool.completed",
                sessionId,
                id: toolCallId,
                name: "computer",
                status: "error",
                errorSummary: redactToolErrorSummary(message),
              },
            });
            write({
              type: "event",
              event: { type: "error", sessionId, message, retryable: false },
            });
          } finally {
            s.streaming = false;
          }
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "attachment-echo") {
          const summaries = await Promise.all((message.attachments ?? []).map(async (attachment) => {
            const file = Bun.file(attachment.path);
            const content = attachment.mediaType === "text/plain" || attachment.mediaType === "application/json"
              ? await file.text()
              : `${file.size} bytes`;
            return `${attachment.id}|${attachment.name}|${attachment.mediaType}|${content}`;
          }));
          emitResponse(sessionId, command.turnId, summaries.join("\n"));
          write({ type: "event", event: { type: "turn.completed", sessionId, usage: { tokens: 1 } } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "ordered-transcript") {
          s.streaming = true;
          s.directive = "ordered-transcript";
          emitResponse(
            sessionId,
            command.turnId,
            [
              "## Release notes",
              "",
              "1. Preserve **ordered blocks**.",
              "2. Keep `Steering` in place.",
              "",
              "| Boundary | Result |",
              "| --- | --- |",
              "| Response → Thinking | separate |",
              "| Tool → Response | separate |",
              "",
              "```ts",
              "const order = [\"response\", \"thinking\", \"tool\", \"response\"];",
              "```",
              "",
              "Long-form context ".repeat(24).trim(),
            ].join("\n"),
          );
          emitThinking(sessionId, command.turnId, "**Inspect** every ordered boundary.", { durationMs: 1_250 });
          const steeringToolId = `ordered-steering-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: steeringToolId,
              name: "read",
              status: "running",
              target: "src/transcript.ts",
            },
          });
          const steered = await new Promise<string>((resolve) => {
            s.steerReply = resolve;
          });
          if (s.aborted) return;
          write({
            type: "event",
            event: {
              type: "tool.completed",
              sessionId,
              id: steeringToolId,
              name: "read",
              status: "completed",
              target: "src/transcript.ts",
              durationMs: 12,
            },
          });
          emitResponse(sessionId, command.turnId, `Steering received: ${steered}`);
          emitResponse(sessionId, command.turnId, "Adjacent response remains in the same visual reply.");
          emitThinking(sessionId, command.turnId, "Check the final interleaving.", { durationMs: 2_500 });
          const finalToolId = `ordered-final-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: finalToolId,
              name: "write",
              status: "running",
              target: "src/transcript.ts",
            },
          });
          write({
            type: "event",
            event: {
              type: "tool.completed",
              sessionId,
              id: finalToolId,
              name: "write",
              status: "completed",
              target: "src/transcript.ts",
              durationMs: 8,
              additions: 4,
              deletions: 1,
            },
          });
          emitResponse(sessionId, command.turnId, "Final response after the second tool.");
          write({
            type: "event",
            event: {
              type: "native",
              sessionId,
              agentId: AGENT_ID,
              capability: "fake.progress",
              payload: { stage: "ordered-boundary" },
              sensitivity: "public",
            },
          });
          emitResponse(sessionId, command.turnId, "Response after an unrendered Native Event boundary.");
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          s.streaming = false;
          s.directive = undefined;
          s.steerReply = undefined;
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "process-only") {
          emitThinking(sessionId, command.turnId, "Hidden process reasoning.", { durationMs: 25 });
          const processToolId = `process-only-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: processToolId,
              name: "read",
              status: "running",
              target: "src/hidden.ts",
            },
          });
          write({
            type: "event",
            event: {
              type: "tool.completed",
              sessionId,
              id: processToolId,
              name: "read",
              status: "completed",
              target: "src/hidden.ts",
              durationMs: 4,
            },
          });
          write({
            type: "event",
            event: {
              type: "native",
              sessionId,
              agentId: AGENT_ID,
              capability: "fake.progress",
              payload: { stage: "process-only" },
              sensitivity: "public",
            },
          });
          await Bun.sleep(150);
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "thinking-order") {
          emitResponse(sessionId, command.turnId, "Before Thinking.");
          emitThinking(sessionId, command.turnId, "**Inspect** the request.", { durationMs: 1_250 });
          const toolCallId = `thinking-tool-${command.turnId}`;
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: toolCallId,
              name: "read",
              status: "running",
              target: "src/input.ts",
            },
          });
          write({
            type: "event",
            event: {
              type: "tool.completed",
              sessionId,
              id: toolCallId,
              name: "read",
              status: "completed",
              target: "src/input.ts",
              durationMs: 12,
            },
          });
          emitThinking(sessionId, command.turnId, "Provider-authored summary.", { durationMs: 2_500 });
          emitResponse(sessionId, command.turnId, "After Thinking.");
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "thinking-stream") {
          const blockId = `fake-thinking-${command.turnId}-${++thinkingCounter}`;
          write({
            type: "event",
            event: { type: "thinking.start", sessionId, blockId, startedAt: new Date().toISOString() },
          });
          await Bun.sleep(250);
          write({
            type: "event",
            event: { type: "thinking.delta", sessionId, blockId, text: "**Inspect" },
          });
          await Bun.sleep(700);
          write({
            type: "event",
            event: { type: "thinking.delta", sessionId, blockId, text: " inputs.**" },
          });
          await Bun.sleep(700);
          write({
            type: "event",
            event: { type: "thinking.end", sessionId, blockId, completedAt: new Date().toISOString() },
          });
          emitResponse(sessionId, command.turnId, "Thinking complete.");
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "thinking-fail" || text === "thinking-crash" || text === "thinking-hang") {
          emitThinking(sessionId, command.turnId, "discard me", { complete: false });
          if (text === "thinking-crash") {
            await Bun.sleep(20);
            process.exit(19);
          }
          if (text === "thinking-fail") {
            write({
              type: "event",
              event: { type: "error", sessionId, message: "fake Thinking failure", retryable: false },
            });
          } else {
            s.streaming = true;
            s.directive = "hang";
          }
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "adjacent-responses") {
          emitResponse(sessionId, command.turnId, "First block.");
          emitResponse(sessionId, command.turnId, "Second block.");
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text.startsWith("say:")) {
          const said = text.slice(4).trim();
          const blockId = `fake-response-${command.turnId}-${++responseCounter}`;
          write({
            type: "event",
            event: { type: "response.start", sessionId, blockId, startedAt: new Date().toISOString() },
          });
          write({ type: "event", event: { type: "response.delta", sessionId, blockId, text: said.slice(0, 3) } });
          await Bun.sleep(350);
          write({ type: "event", event: { type: "response.delta", sessionId, blockId, text: said.slice(3) } });
          await Bun.sleep(350);
          write({
            type: "event",
            event: { type: "response.end", sessionId, blockId, completedAt: new Date().toISOString() },
          });
          write({ type: "event", event: { type: "turn.completed", sessionId, usage: { tokens: 1 } } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "undeclared-events") {
          write({ type: "event", event: { type: "tool.started", sessionId, id: "undeclared-tool", name: "secret-tool", status: "running", input: { token: "must-not-leak" } } });
          write({
            type: "event",
            event: {
              type: "native",
              sessionId,
              agentId: AGENT_ID,
              capability: "fake.secret-progress",
              payload: { token: "must-not-leak" },
              sensitivity: "secret",
            },
          });
          write({
            type: "event",
            event: {
              type: "native",
              sessionId,
              agentId: AGENT_ID,
              capability: "fake.diagnostic-progress",
              payload: { trace: "must-not-leak" },
              sensitivity: "diagnostic",
            },
          });
          emitResponse(sessionId, command.turnId, "declared response");
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "tool-hang" || text === "tool-fail" || text === "tool-crash") {
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: `interrupted-${command.turnId}`,
              name: "bash",
              status: "running",
              target: "safe interrupted operation",
            },
          });
          if (text === "tool-crash") process.exit(17);
          if (text === "tool-fail") {
            write({
              type: "event",
              event: { type: "error", sessionId, message: "fake failure", retryable: false },
            });
          } else {
            s.streaming = true;
            s.directive = "hang";
          }
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text.startsWith("tool")) {
          const firstToolId = `tool-1-${command.turnId}`;
          const secondToolId = `tool-2-${command.turnId}`;
          write({ type: "event", event: { type: "tool.started", sessionId, id: firstToolId, name: "bash", status: "running", target: "echo fake" } });
          await Bun.sleep(100);
          write({ type: "event", event: { type: "tool.updated", sessionId, id: firstToolId, name: "bash", status: "running", target: "echo fake" } });
          await Bun.sleep(100);
          if (!text.includes("adjacent") && !text.includes("separated")) {
            write({
              type: "event",
              event: {
                type: "native",
                sessionId,
                agentId: AGENT_ID,
                capability: "fake.progress",
                payload: { stage: "tool-running" },
                sensitivity: "public",
              },
            });
          }
          write({ type: "event", event: { type: "tool.completed", sessionId, id: firstToolId, name: "bash", status: "completed", target: "echo fake", durationMs: 12 } });
          if (text.includes("separated")) emitResponse(sessionId, command.turnId, "Between tools.");
          if (text.includes("adjacent") || text.includes("separated")) {
            write({ type: "event", event: { type: "tool.started", sessionId, id: secondToolId, name: "write", status: "running", target: "/tmp/fake.txt" } });
            await Bun.sleep(100);
            write({ type: "event", event: { type: "tool.completed", sessionId, id: secondToolId, name: "write", status: "completed", target: "/tmp/fake.txt", durationMs: 8, additions: 1, deletions: 0 } });
          }
          if (!text.includes("no-response")) emitResponse(sessionId, command.turnId, "tool finished");
          await Bun.sleep(150);
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "fail-once") {
          if (!failedOnce.has(text)) {
            failedOnce.add(text);
            write({ type: "event", event: { type: "error", sessionId, message: "fake failure", retryable: true } });
          } else {
            emitResponse(sessionId, command.turnId, "recovered");
            write({ type: "event", event: { type: "turn.completed", sessionId } });
          }
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "timeout-failure") {
          write({ type: "event", event: { type: "error", sessionId, message: "timed out after 30s", retryable: true } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "partial-fail") {
          emitResponse(sessionId, command.turnId, "discard me", false);
          write({ type: "event", event: { type: "error", sessionId, message: "fake partial failure", retryable: false } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "partial-crash") {
          emitResponse(sessionId, command.turnId, "discard me", false);
          await Bun.sleep(20);
          process.exit(9);
        }
        if (text === "fail") {
          write({ type: "event", event: { type: "error", sessionId, message: "fake failure", retryable: false } });
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "hang") {
          s.streaming = true;
          s.directive = "hang";
          emitResponse(sessionId, command.turnId, "hanging…", false);
          // never completes; turn.abort must arrive. steering is unsupported here.
          respond(msg.requestId!, { accepted: true });
          return;
        }
        if (text === "steer-echo") {
          s.streaming = true;
          s.directive = "steer-echo";
          write({
            type: "event",
            event: {
              type: "tool.started",
              sessionId,
              id: "steer-boundary",
              name: "fake-atomic-action",
              status: "running",
              target: "after-steer-queued",
            },
          });
          // The worker can receive a steer while this atomic action is active.
          // Resolving is queued as a microtask, so message.steer is acknowledged
          // before the action completes at its safe boundary.
          const steered = await new Promise<string>((resolve) => {
            s.steerReply = resolve;
          });
          if (s.aborted) return;
          write({
            type: "event",
            event: {
              type: "tool.completed",
              sessionId,
              id: "steer-boundary",
              name: "fake-atomic-action",
              status: "completed",
            },
          });
          if (s.aborted) return;
          emitResponse(sessionId, command.turnId, `steered: ${steered}`);
          write({ type: "event", event: { type: "turn.completed", sessionId } });
          s.streaming = false;
          s.directive = undefined;
          s.steerReply = undefined;
          respond(msg.requestId!, { accepted: true });
          return;
        }
        write({ type: "event", event: { type: "turn.completed", sessionId } });
        respond(msg.requestId!, { accepted: true });
      })();
      break;
    }
    case "message.steer": {
      recordCommand("message.steer");
      const { sessionId, text } = msg as unknown as { sessionId: string; text: string };
      if (text === "crash-agent") process.exit(17);
      const s = sessions.get(sessionId);
      if (!s || !s.streaming) {
        respondError(msg.requestId!, "cannot steer: session is not streaming");
        break;
      }
      if (s.directive === "hang") {
        respondError(msg.requestId!, "fake hang is not steerable");
        break;
      }
      if (!["steer-echo", "ordered-transcript"].includes(s.directive ?? "") || !s.steerReply) {
        respondError(msg.requestId!, "fake session has no steering boundary");
        break;
      }
      s.steerReply(text);
      respond(msg.requestId!, { steered: true });
      break;
    }
    case "turn.abort": {
      recordCommand("turn.abort");
      const { sessionId } = msg as unknown as { sessionId: string };
      const control = probeControl();
      if (control.fakeAbortBehavior === "fail_once" && !failedAbortOnce.has(sessionId)) {
        failedAbortOnce.add(sessionId);
        respondError(msg.requestId!, "simulated turn abort failure");
        break;
      }
      if (control.fakeAbortBehavior === "ignore_once" && !ignoredAbortOnce.has(sessionId)) {
        ignoredAbortOnce.add(sessionId);
        respond(msg.requestId!, { aborted: true });
        break;
      }

      const cancel = (): void => {
        const s = sessions.get(sessionId);
        if (!s) return;
        // turnAbort covers every in-flight bridge (computer, local, send_bot_message),
        // so abort it before the streaming gate: local and mail calls never stream.
        s.turnAbort?.abort();
        delete s.turnAbort;
        if (!s.streaming && s.toolInFlight !== true) return;
        s.aborted = true;
        s.streaming = false;
        s.toolInFlight = false;
        s.steerReply?.("");
        s.steerReply = undefined;
        s.directive = undefined;
        write({ type: "event", event: { type: "turn.cancelled", sessionId } });
      };
      const root = dataDir();
      if (
        root !== undefined
        && typeof control.fakeAbortReleaseFile === "string"
        && control.fakeAbortReleaseFile.length > 0
      ) {
        respond(msg.requestId!, { aborted: true });
        void (async () => {
          const releasePath = path.join(root, control.fakeAbortReleaseFile!);
          while (!existsSync(releasePath)) await Bun.sleep(10);
          cancel();
        })();
        break;
      }
      cancel();
      respond(msg.requestId!, { aborted: true });
      break;
    }
    case "session.history":
      respond(msg.requestId!, {
        messages: [
          { role: "user", text: "history-user" },
          { role: "assistant", text: "history-assistant" },
        ],
      });
      break;
    case "session.close": {
      // Every pending bridge call for this session settles here; others keep working.
      const { sessionId } = msg as unknown as { sessionId: string };
      toolChannel.close(sessionId);
      respond(msg.requestId!, {});
      break;
    }
    default:
      if (msg.requestId) respondError(msg.requestId, `unknown command ${msg.type}`);
  }
});
