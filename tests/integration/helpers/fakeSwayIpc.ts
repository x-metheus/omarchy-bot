import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("i3-ipc");
const HEADER_LENGTH = 14;
export const SWAY_IPC_GET_TREE = 4;
export const SWAY_IPC_RUN_COMMAND = 0;

export type FakeSwayIpcMode = "ok" | "refuse" | "hang" | "ack";

export function fakeSwayIpcPaths(controlDir: string): {
  treePath: string;
  commandsPath: string;
  modePath: string;
} {
  return {
    treePath: path.join(controlDir, "tree.json"),
    commandsPath: path.join(controlDir, "commands.log"),
    modePath: path.join(controlDir, "mode.txt"),
  };
}

export function writeFakeSwayTree(controlDir: string, tree: unknown): void {
  writeFileSync(fakeSwayIpcPaths(controlDir).treePath, `${JSON.stringify(tree)}\n`);
}

export function writeFakeSwayIpcMode(controlDir: string, mode: FakeSwayIpcMode): void {
  writeFileSync(fakeSwayIpcPaths(controlDir).modePath, `${mode}\n`);
}

export function readFakeSwayCommands(controlDir: string): string[] {
  const { commandsPath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(commandsPath)) return [];
  return readFileSync(commandsPath, "utf8").split("\n").filter((line) => line !== "");
}

function readMode(controlDir: string): FakeSwayIpcMode {
  const { modePath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(modePath)) return "ok";
  const mode = readFileSync(modePath, "utf8").trim();
  if (mode === "refuse" || mode === "hang" || mode === "ack") return mode;
  return "ok";
}

function encodeMessage(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(body.byteLength, 6);
  header.writeUInt32LE(type, 10);
  return Buffer.concat([header, body]);
}

function takeMessage(buffer: Buffer): { type: number; payload: string; rest: Buffer } | undefined {
  if (buffer.byteLength < HEADER_LENGTH) return undefined;
  if (!buffer.subarray(0, 6).equals(MAGIC)) {
    throw new Error("fake Sway IPC received a message without the i3-ipc magic");
  }
  const length = buffer.readUInt32LE(6);
  if (buffer.byteLength < HEADER_LENGTH + length) return undefined;
  return {
    type: buffer.readUInt32LE(10),
    payload: buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString("utf8"),
    rest: buffer.subarray(HEADER_LENGTH + length),
  };
}

function markContainerFocused(node: unknown, containerId: number): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => markContainerFocused(child, containerId));
  const record = node as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  if (typeof record.id === "number") next.focused = record.id === containerId;
  if (Array.isArray(record.nodes)) next.nodes = record.nodes.map((child) => markContainerFocused(child, containerId));
  if (Array.isArray(record.floating_nodes)) {
    next.floating_nodes = record.floating_nodes.map((child) => markContainerFocused(child, containerId));
  }
  return next;
}

function handleCommand(controlDir: string, payload: string): string {
  const { commandsPath, treePath } = fakeSwayIpcPaths(controlDir);
  appendFileSync(commandsPath, `${payload}\n`);
  if (readMode(controlDir) === "refuse") {
    return JSON.stringify([{ success: false, error: "refused" }]);
  }
  const focused = /^\[con_id=(\d+)\] focus$/.exec(payload);
  if (focused !== null && existsSync(treePath) && readMode(controlDir) !== "ack") {
    const tree = JSON.parse(readFileSync(treePath, "utf8")) as unknown;
    writeFakeSwayTree(controlDir, markContainerFocused(tree, Number(focused[1])));
  }
  const moved = /^\[con_id=(\d+)\] move container to workspace (\S+)$/.exec(payload);
  if (moved !== null && existsSync(treePath) && readMode(controlDir) !== "ack") {
    const tree = JSON.parse(readFileSync(treePath, "utf8")) as unknown;
    writeFakeSwayTree(controlDir, moveContainerToWorkspace(tree, Number(moved[1]), moved[2]!));
  }
  return JSON.stringify([{ success: true }]);
}

type SwayRecord = Record<string, unknown>;

function childArrays(node: SwayRecord): unknown[][] {
  return [node.nodes, node.floating_nodes]
    .filter((value): value is unknown[] => Array.isArray(value));
}

function detachContainer(node: unknown, containerId: number): unknown {
  if (node === null || typeof node !== "object") return undefined;
  for (const children of childArrays(node as SwayRecord)) {
    const index = children.findIndex((child) =>
      child !== null && typeof child === "object" && (child as SwayRecord).id === containerId
    );
    if (index >= 0) return children.splice(index, 1)[0];
    for (const child of children) {
      const detached = detachContainer(child, containerId);
      if (detached !== undefined) return detached;
    }
  }
  return undefined;
}

function findRecord(
  node: unknown,
  matches: (record: SwayRecord) => boolean,
): SwayRecord | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as SwayRecord;
  if (matches(record)) return record;
  for (const children of childArrays(record)) {
    for (const child of children) {
      const found = findRecord(child, matches);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function highestNodeId(node: unknown, highest = 0): number {
  if (node === null || typeof node !== "object") return highest;
  const record = node as SwayRecord;
  let next = typeof record.id === "number" ? Math.max(highest, record.id) : highest;
  for (const children of childArrays(record)) {
    for (const child of children) next = highestNodeId(child, next);
  }
  return next;
}

/**
 * Models `move container to workspace` so a routing assertion can re-read a tree
 * the way Sway would report it. A workspace the fixture tree does not have yet
 * is created under the first output, matching a Sway workspace command.
 */
function moveContainerToWorkspace(tree: unknown, containerId: number, workspaceName: string): unknown {
  if (tree === null || typeof tree !== "object") return tree;
  const container = detachContainer(tree, containerId);
  if (container === undefined) return tree;
  let workspace = findRecord(
    tree,
    (record) => record.type === "workspace" && record.name === workspaceName,
  );
  if (workspace === undefined) {
    const output = findRecord(tree, (record) => record.type === "output") ?? tree as SwayRecord;
    if (!Array.isArray(output.nodes)) output.nodes = [];
    workspace = {
      id: highestNodeId(tree) + 1,
      type: "workspace",
      name: workspaceName,
      nodes: [],
      floating_nodes: [],
    };
    (output.nodes as unknown[]).push(workspace);
  }
  const key = (container as SwayRecord).type === "floating_con" ? "floating_nodes" : "nodes";
  if (!Array.isArray(workspace[key])) workspace[key] = [];
  (workspace[key] as unknown[]).push(container);
  return tree;
}

export async function serveFakeSwayIpc(input: {
  socketPath: string;
  controlDir: string;
}): Promise<void> {
  const pending = new WeakMap<object, Buffer>();
  Bun.listen({
    unix: input.socketPath,
    socket: {
      data(socket, data) {
        try {
          let buffer = Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), Buffer.from(data)]);
          for (;;) {
            const message = takeMessage(buffer);
            if (message === undefined) {
              pending.set(socket, buffer);
              return;
            }
            buffer = Buffer.from(message.rest);
            pending.set(socket, buffer);
            const mode = readMode(input.controlDir);
            if (mode === "hang") return;
            if (message.type === SWAY_IPC_GET_TREE) {
              const { treePath } = fakeSwayIpcPaths(input.controlDir);
              if (!existsSync(treePath)) {
                socket.end();
                return;
              }
              socket.write(encodeMessage(SWAY_IPC_GET_TREE, readFileSync(treePath, "utf8")));
              continue;
            }
            if (message.type === SWAY_IPC_RUN_COMMAND) {
              socket.write(encodeMessage(SWAY_IPC_RUN_COMMAND, handleCommand(input.controlDir, message.payload)));
              continue;
            }
            socket.end();
            return;
          }
        } catch {
          socket.end();
        }
      },
    },
  });
  await new Promise(() => {});
}
