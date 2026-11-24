import { readFile } from "node:fs/promises";
import type {
  AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, Usage,
} from "@earendil-works/pi-ai";

interface LegacyHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
}

interface LegacyEntry extends Record<string, unknown> {
  type: string;
  id: string;
}

export interface LegacySession {
  header: LegacyHeader;
  entries: LegacyEntry[];
}

export interface LegacySeedEntry {
  kind: string;
  data: { sourceId: string; timestamp: string; role?: string };
  model: Message[];
}

export interface MigrationCounts {
  user: number;
  assistant: number;
  toolResult: number;
  labeled: number;
  thinkingDropped: number;
  dropped: number;
  droppedByType: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const isoTimestamp = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function isHeader(value: unknown): value is LegacyHeader {
  return isRecord(value) && value.type === "session" && value.version === 3
    && nonEmptyString(value.id) && nonEmptyString(value.cwd)
    && typeof value.timestamp === "string" && isoTimestamp.test(value.timestamp) && Number.isFinite(Date.parse(value.timestamp));
}

function isEntry(value: unknown): value is LegacyEntry {
  return isRecord(value) && nonEmptyString(value.type) && nonEmptyString(value.id);
}

export async function readLegacySession(path: string): Promise<LegacySession> {
  const file = await readFile(path, "utf8");
  let header: LegacyHeader | undefined;
  const entries: LegacyEntry[] = [];
  let offset = 0;
  for (let lineNumber = 1; offset < file.length; lineNumber++) {
    const newline = file.indexOf("\n", offset);
    const end = newline === -1 ? file.length : newline;
    const line = file.slice(offset, end);
    offset = end + 1;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid legacy session JSON on line ${lineNumber}`);
    }
    if (!header) {
      if (isRecord(value) && value.type === "session" && typeof value.version === "number" && value.version !== 3) {
        throw new Error(`Unsupported legacy session version ${value.version}`);
      }
      if (!isHeader(value)) throw new Error("Invalid legacy session header");
      header = value;
    } else {
      if (!isEntry(value)) throw new Error(`Invalid legacy session entry on line ${lineNumber}`);
      if (value.type === "compaction") entries.length = 0;
      entries.push(value);
    }
  }
  if (!header) throw new Error("Missing legacy session header");
  return { header, entries };
}

export function selectLegacyWindow(session: LegacySession): LegacyEntry[] {
  const index = session.entries.findLastIndex((entry) => entry.type === "compaction");
  if (index === -1) return session.entries.slice();
  if (typeof session.entries[index]?.summary !== "string") throw new Error("Invalid legacy compaction summary");
  return session.entries.slice(index);
}

function legacyMessage(entry: LegacyEntry): Record<string, unknown> {
  return entry.type === "message" && isRecord(entry.message) ? entry.message : {};
}

function messageTimestamp(entry: LegacyEntry, timestamp?: unknown): number {
  if (isFiniteNumber(timestamp)) {
    const milliseconds = Math.floor(timestamp);
    if (Number.isFinite(new Date(milliseconds).getTime())) return milliseconds;
  }
  const entryTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(entryTime) ? entryTime : Date.now();
}

function seedEntry(kind: string, entry: LegacyEntry, message: Message, role?: string): LegacySeedEntry {
  const data: LegacySeedEntry["data"] = { sourceId: entry.id, timestamp: new Date(message.timestamp).toISOString() };
  if (role !== undefined) data.role = role;
  return { kind, data, model: [message] };
}

function isText(block: unknown): block is TextContent {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function nativeTextOrImage(block: TextContent | ImageContent): TextContent | ImageContent {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mimeType: block.mimeType };
}

function isTextOrImage(block: unknown): block is TextContent | ImageContent {
  return isText(block) || (isRecord(block) && block.type === "image"
    && typeof block.data === "string" && nonEmptyString(block.mimeType));
}

function isToolCall(block: unknown): block is ToolCall {
  // Tool arguments already came from JSON. The native call requires an object at the root.
  return isRecord(block) && block.type === "toolCall" && nonEmptyString(block.id) && nonEmptyString(block.name)
    && isRecord(block.arguments) && (block.namespace === undefined || typeof block.namespace === "string")
    && (block.argumentsError === undefined || typeof block.argumentsError === "string");
}

function isThinking(block: unknown): boolean {
  return isRecord(block) && block.type === "thinking";
}

function nativeAssistantBlock(block: TextContent | ToolCall): TextContent | ToolCall {
  if (block.type === "text") return { type: "text", text: block.text };
  const call: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
  if (block.namespace !== undefined) call.namespace = block.namespace;
  if (block.argumentsError !== undefined) call.argumentsError = block.argumentsError;
  return call;
}

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const { cost } = value;
  const tokenFields = ["input", "output", "cacheRead", "cacheWrite"];
  return [...tokenFields, "totalTokens"].every((field) => isFiniteNumber(value[field]))
    && (value.cacheWrite1h === undefined || isFiniteNumber(value.cacheWrite1h))
    && (value.reasoning === undefined || isFiniteNumber(value.reasoning))
    && isRecord(cost) && [...tokenFields, "total"].every((field) => isFiniteNumber(cost[field]))
    && (cost.totalFromProvider === undefined || typeof cost.totalFromProvider === "boolean");
}

function nativeAssistant(message: Record<string, unknown>, content: unknown[], timestamp: number): AssistantMessage | undefined {
  const { api, provider, model, usage, stopReason } = message;
  if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") return;
  if (content.length === 0 || !content.every((block) => isText(block) || isToolCall(block))
    || !nonEmptyString(api) || !nonEmptyString(provider) || !nonEmptyString(model) || !isUsage(usage)) return;
  const hasToolCalls = content.some((block) => block.type === "toolCall");
  if (hasToolCalls !== (stopReason === "toolUse")) return;
  return { role: "assistant", content: content.map(nativeAssistantBlock), api, provider, model, usage, stopReason, timestamp };
}

function matchingToolResults(messages: LegacyEntry[], index: number, calls: ToolCall[]): LegacySeedEntry[] | undefined {
  const results: LegacySeedEntry[] = [];
  const matched = new Set<string>();
  for (const [offset, call] of calls.entries()) {
    const entry = messages[index + offset + 1];
    if (!entry || matched.has(call.id)) return;
    const { role, toolCallId, toolName, content, isError, timestamp } = legacyMessage(entry);
    if (role !== "toolResult" || toolCallId !== call.id || toolName !== call.name
      || !Array.isArray(content) || !content.every(isTextOrImage) || typeof isError !== "boolean") return;
    const result: ToolResultMessage = {
      role, toolCallId, toolName, content: content.map(nativeTextOrImage), isError, timestamp: messageTimestamp(entry, timestamp),
    };
    results.push(seedEntry("legacy.message", entry, result, role));
    matched.add(call.id);
  }
  return results;
}

function serializeVisibleContent(content: unknown): string {
  return JSON.stringify(content, (key, value: unknown) => {
    if (key === "textSignature" || key === "thinkingSignature" || key === "thoughtSignature" || key === "redacted" || isThinking(value)) {
      return undefined;
    }
    return Array.isArray(value) ? value.filter((block) => !isThinking(block)) : value;
  }) ?? "";
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return serializeVisibleContent(content);
  return content.filter((block) => !isThinking(block)).map((block: unknown) =>
    isText(block) ? block.text : serializeVisibleContent(block)).join("\n");
}

function labelMessage(message: Record<string, unknown>, role: string, timestamp: number): Message {
  const name = [message.name, message.customType, message.command, message.model].find(nonEmptyString) ?? role;
  const label = role === "toolResult"
    ? `[old tool result: ${nonEmptyString(message.toolName) ? message.toolName : "unknown"}]`
    : `[old ${role} message: ${name}]`;
  const content = Object.hasOwn(message, "content") ? message.content : message.output ?? message.summary;
  return { role: "user", content: `${label}\n${flattenContent(content)}`, timestamp };
}

export function legacySessionSeed(session: LegacySession): { entries: LegacySeedEntry[]; counts: MigrationCounts } {
  const entries: LegacySeedEntry[] = [];
  const counts: MigrationCounts = { user: 0, assistant: 0, toolResult: 0, labeled: 0, thinkingDropped: 0, dropped: 0, droppedByType: {} };
  const droppedByType = new Map<string, number>();
  const messages: LegacyEntry[] = [];
  for (const entry of selectLegacyWindow(session)) {
    if (entry.type === "compaction") {
      entries.push(seedEntry("legacy.compaction", entry, {
        role: "user", content: `Previous conversation compaction summary:\n${entry.summary}`, timestamp: messageTimestamp(entry),
      }));
    } else if (entry.type === "message") {
      messages.push(entry);
    } else {
      droppedByType.set(entry.type, (droppedByType.get(entry.type) ?? 0) + 1);
      counts.dropped++;
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const entry = messages[index]!;
    const message = legacyMessage(entry);
    const role = nonEmptyString(message.role) ? message.role : "unknown";
    const timestamp = messageTimestamp(entry, message.timestamp);
    const { content } = message;
    if (role === "user" && (typeof content === "string" || (Array.isArray(content) && content.every(isTextOrImage)))) {
      entries.push(seedEntry("legacy.message", entry, { role, content: typeof content === "string" ? content : content.map(nativeTextOrImage), timestamp }, role));
      counts.user++;
      continue;
    }
    if (role === "assistant" && Array.isArray(content) && message.stopReason !== "error" && message.stopReason !== "aborted") {
      const visibleContent = content.filter((block) => !isThinking(block));
      if (content.length > 0 && visibleContent.length === 0) {
        counts.thinkingDropped++;
        continue;
      }
      const assistant = nativeAssistant(message, visibleContent, timestamp);
      if (assistant) {
        const calls = assistant.content.filter((block) => block.type === "toolCall");
        const results = matchingToolResults(messages, index, calls);
        if (results) {
          entries.push(seedEntry("legacy.message", entry, assistant, role));
          for (const result of results) entries.push(result);
          counts.assistant++;
          counts.toolResult += results.length;
          // The matching results were emitted with their assistant. Skip them on the next iteration.
          index += results.length;
          continue;
        }
      }
    }
    entries.push(seedEntry("legacy.labeled", entry, labelMessage(message, role, timestamp), role));
    counts.labeled++;
  }
  counts.droppedByType = Object.fromEntries(droppedByType);
  return { entries, counts };
}

export function formatMigrationLog(counts: MigrationCounts): string {
  return `user=${counts.user} assistant=${counts.assistant} toolResult=${counts.toolResult} labeled=${counts.labeled} thinking=${counts.thinkingDropped} dropped=${counts.dropped}`;
}
