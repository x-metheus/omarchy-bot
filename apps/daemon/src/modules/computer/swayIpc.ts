import { createConnection, type Socket } from "node:net";
import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";

const MAGIC = Buffer.from("i3-ipc");
export const BOT_DESKTOP_APP_ID = "dev.omarchy.BotDesktop";
const HEADER_LENGTH = 14;
const TYPE_RUN_COMMAND = 0;
const TYPE_SUBSCRIBE = 2;
const TYPE_GET_TREE = 4;
const EVENT_BIT = 0x80000000;
/** Sway's `window` event type inside the event-bit space. */
const SWAY_WINDOW_EVENT = 3;
const IPC_TIMEOUT_MS = 1_500;
function commandSucceeded(entry: unknown): boolean {
  return entry !== null
    && typeof entry === "object"
    && "success" in entry
    && entry.success === true;
}

function commandError(entry: unknown): string | undefined {
  if (
    entry === null
    || typeof entry !== "object"
    || !("error" in entry)
    || typeof entry.error !== "string"
  ) {
    return undefined;
  }
  return entry.error;
}


export class SwayIpcClient {
  constructor(private readonly socketPath: string) {}

  async getTree(signal?: AbortSignal): Promise<unknown> {
    const payload = await this.#request(TYPE_GET_TREE, "", signal);
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      throw new Error("Sway IPC returned an unreadable tree");
    }
  }

  async runCommand(command: string, signal?: AbortSignal): Promise<void> {
    const payload = await this.#request(TYPE_RUN_COMMAND, command, signal);
    let results: unknown;
    try {
      results = JSON.parse(payload) as unknown;
    } catch {
      throw new Error("Sway command returned an unreadable reply");
    }
    const refused = !Array.isArray(results)
      || results.length === 0
      || results.some((entry) => !commandSucceeded(entry));
    if (refused) {
      const detail = Array.isArray(results)
        ? results.flatMap((entry) => {
          const error = commandError(entry);
          return error === undefined ? [] : [error];
        }).join("; ")
        : "";
      throw new Error(
        `Sway command was refused: ${command}${detail === "" ? "" : ` (${detail})`}`,
      );
    }
  }

  async #request(type: number, payload: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const socket = await connectSwaySocket(this.socketPath, signal);
    const abort = () => socket.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      socket.write(encodeMessage(type, payload));
      const reply = await readReply(socket, type);
      signal?.throwIfAborted();
      return reply;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
    }
  }
}

/** One decoded Sway `window` event, reduced to the fields a window list carries. */
export interface SwayWindowEvent {
  /** Sway's change name: `new`, `focus`, `close`, ... */
  change: string;
  window: ComputerWindowListItem;
}

/**
 * A long-lived Sway IPC subscription to `window` events. It keeps its own
 * connection so request-per-call traffic is unaffected, and `close()` is safe
 * to repeat: a stopped Bot Computer may be torn down from more than one path.
 */
export class SwayWindowSubscription {
  #socket: Socket;
  #buffer = Buffer.alloc(0);
  #listeners = new Set<(event: SwayWindowEvent) => void>();
  #ack: Promise<void>;
  #acknowledge!: () => void;
  #refuse!: (error: Error) => void;
  #acknowledged = false;
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    this.#ack = new Promise<void>((resolve, reject) => {
      this.#acknowledge = resolve;
      this.#refuse = reject;
    });
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.once("close", () => this.#fail(new Error("Sway IPC is unavailable")));
    socket.once("error", (error: Error) => {
      this.#fail(new Error(`Sway IPC is unavailable: ${error.message}`));
    });
  }

  static async open(socketPath: string): Promise<SwayWindowSubscription> {
    const socket = await connectSwaySocket(socketPath);
    const subscription = new SwayWindowSubscription(socket);
    const timer = setTimeout(() => {
      subscription.#fail(new Error("Sway window subscription timed out"));
    }, IPC_TIMEOUT_MS);
    timer.unref?.();
    try {
      socket.write(encodeMessage(TYPE_SUBSCRIBE, JSON.stringify(["window"])));
      await subscription.#ack;
      return subscription;
    } catch (error) {
      subscription.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Listens for decoded window events; returns the unsubscribe function. */
  onWindowEvent(listener: (event: SwayWindowEvent) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#fail(new Error("Sway window subscription is closed"));
  }

  #read(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= HEADER_LENGTH) {
      if (!this.#buffer.subarray(0, 6).equals(MAGIC)) {
        this.#fail(new Error("Sway IPC returned an invalid reply"));
        return;
      }
      const length = this.#buffer.readUInt32LE(6);
      if (this.#buffer.byteLength < HEADER_LENGTH + length) return;
      const type = this.#buffer.readUInt32LE(10);
      const payload = this.#buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(HEADER_LENGTH + length);
      if ((type & EVENT_BIT) !== 0) {
        if ((type & ~EVENT_BIT) !== SWAY_WINDOW_EVENT) continue;
        const event = decodeWindowEvent(payload);
        if (event !== undefined) {
          for (const listener of [...this.#listeners]) listener(event);
        }
        continue;
      }
      if (type !== TYPE_SUBSCRIBE) {
        this.#fail(new Error("Sway IPC returned an unexpected reply type"));
        return;
      }
      this.#accept(payload);
    }
  }

  #accept(payload: string): void {
    let accepted = false;
    try {
      const reply = JSON.parse(payload) as unknown;
      accepted = Array.isArray(reply)
        ? reply.length > 0 && reply.every(commandSucceeded)
        : commandSucceeded(reply);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      this.#fail(new Error("Sway window subscription was refused"));
      return;
    }
    if (this.#acknowledged) return;
    this.#acknowledged = true;
    this.#acknowledge();
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#socket.destroy();
    if (!this.#acknowledged) this.#refuse(error);
  }
}

function decodeWindowEvent(payload: string): SwayWindowEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const container = record.container;
  if (container === null || typeof container !== "object" || Array.isArray(container)) return undefined;
  const window = container as Record<string, unknown>;
  if (typeof window.id !== "number" || !isApplicationToplevel(window)) return undefined;
  return {
    change: typeof record.change === "string" ? record.change : "unknown",
    window: toWindow(window, undefined),
  };
}

export function listApplicationToplevels(tree: unknown): ComputerWindowListItem[] {
  const windows: ComputerWindowListItem[] = [];
  walk(tree, undefined, windows);
  return windows;
}

function walk(node: unknown, workspace: string | undefined, windows: ComputerWindowListItem[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  const nextWorkspace = record.type === "workspace" && typeof record.name === "string"
    ? record.name
    : workspace;
  if (isApplicationToplevel(record)) {
    windows.push(toWindow(record, nextWorkspace));
  }
  for (const child of [...asNodes(record.nodes), ...asNodes(record.floating_nodes)]) {
    walk(child, nextWorkspace, windows);
  }
}

function isApplicationToplevel(node: Record<string, unknown>): boolean {
  if (node.app_id === BOT_DESKTOP_APP_ID) return false;
  if (node.type !== "con" && node.type !== "floating_con") return false;
  if (typeof node.app_id === "string" && node.app_id !== "") return true;
  if (node.window !== undefined && node.window !== null) return true;
  return node.shell === "xdg_shell" || node.shell === "xwayland";
}

function toWindow(node: Record<string, unknown>, workspace: string | undefined): ComputerWindowListItem {
  const window: ComputerWindowListItem = {
    id: String(node.id),
    title: typeof node.name === "string" ? node.name : "",
    focused: node.focused === true,
    // A live tree always carries `visible`; a fixture that omits it models a
    // container Sway shows on its workspace.
    visible: node.visible !== false,
    clientType: node.shell === "xwayland" || (node.window !== undefined && node.window !== null)
      ? "x11"
      : "wayland",
  };
  if (typeof node.app_id === "string" && node.app_id !== "") window.appId = node.app_id;
  const properties = node.window_properties;
  if (window.appId === undefined && properties !== null && typeof properties === "object"
    && "class" in properties && typeof properties.class === "string" && properties.class !== "") {
    window.appId = properties.class;
  }
  if (typeof node.pid === "number") window.pid = node.pid;
  const bounds = boundsOf(node.rect);
  if (bounds !== undefined) window.bounds = bounds;
  if (workspace !== undefined) window.workspace = workspace;
  return window;
}

function boundsOf(rect: unknown): ComputerWindowListItem["bounds"] | undefined {
  if (rect === null || typeof rect !== "object") return undefined;
  const record = rect as Record<string, unknown>;
  if (
    typeof record.x !== "number"
    || typeof record.y !== "number"
    || typeof record.width !== "number"
    || typeof record.height !== "number"
  ) {
    return undefined;
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

function asNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function connectSwaySocket(socketPath: string, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    const fail = (error: unknown): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onAbort = () => fail(signal!.reason);
    const onError = (error: Error) => fail(new Error(`Sway IPC is unavailable: ${error.message}`));
    const timer = setTimeout(() => fail(new Error("Sway IPC connect timed out")), IPC_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function encodeMessage(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(body.byteLength, 6);
  header.writeUInt32LE(type, 10);
  return Buffer.concat([header, body]);
}

function readReply(socket: Socket, expectedType: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Sway IPC timed out"));
    }, IPC_TIMEOUT_MS);
    timer.unref?.();
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < HEADER_LENGTH) return;
      if (!buffer.subarray(0, 6).equals(MAGIC)) {
        cleanup();
        reject(new Error("Sway IPC returned an invalid reply"));
        return;
      }
      const length = buffer.readUInt32LE(6);
      if (buffer.byteLength < HEADER_LENGTH + length) return;
      const type = buffer.readUInt32LE(10) & ~EVENT_BIT;
      if (type !== expectedType) {
        cleanup();
        reject(new Error("Sway IPC returned an unexpected reply type"));
        return;
      }
      cleanup();
      resolve(buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString("utf8"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Sway IPC is unavailable"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`Sway IPC is unavailable: ${error.message}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.destroy();
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
