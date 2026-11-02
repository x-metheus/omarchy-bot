import { createConnection, type Socket } from "node:net";
import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";

const MAGIC = Buffer.from("i3-ipc");
export const BOT_DESKTOP_APP_ID = "dev.omarchy.BotDesktop";
const HEADER_LENGTH = 14;
const TYPE_RUN_COMMAND = 0;
const TYPE_GET_TREE = 4;
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

  async getTree(): Promise<unknown> {
    const payload = await this.#request(TYPE_GET_TREE, "");
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      throw new Error("Sway IPC returned an unreadable tree");
    }
  }

  async runCommand(command: string): Promise<void> {
    const payload = await this.#request(TYPE_RUN_COMMAND, command);
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

  async #request(type: number, payload: string): Promise<string> {
    const socket = await this.#connect();
    try {
      socket.write(encodeMessage(type, payload));
      return await readReply(socket, type);
    } finally {
      socket.destroy();
    }
  }

  #connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const fail = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
      });
      const onError = (error: Error): void => {
        fail(new Error(`Sway IPC is unavailable: ${error.message}`));
      };
      socket.once("error", onError);
    });
  }
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
      const type = buffer.readUInt32LE(10) & ~0x80000000;
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
