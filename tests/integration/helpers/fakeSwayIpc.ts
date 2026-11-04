import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("i3-ipc");
const HEADER_LENGTH = 14;
export const SWAY_IPC_GET_TREE = 4;
export const SWAY_IPC_RUN_COMMAND = 0;
export const SWAY_IPC_SUBSCRIBE = 2;
const SWAY_WINDOW_EVENT = 0x80000003;
const SCRATCHPAD_WORKSPACE = "__i3_scratch";

export type FakeSwayIpcMode = "ok" | "refuse" | "hang" | "ack" | "refuse-scratchpad" | "ack-route";

export function fakeSwayIpcPaths(controlDir: string): {
  treePath: string;
  commandsPath: string;
  modePath: string;
  eventsPath: string;
  subscriptionsPath: string;
  deliveriesPath: string;
} {
  return {
    treePath: path.join(controlDir, "tree.json"),
    commandsPath: path.join(controlDir, "commands.log"),
    modePath: path.join(controlDir, "mode.txt"),
    eventsPath: path.join(controlDir, "events.jsonl"),
    subscriptionsPath: path.join(controlDir, "subscriptions.log"),
    deliveriesPath: path.join(controlDir, "event-deliveries.log"),
  };
}

let treeWriteSequence = 0;
const treeLockWait = new Int32Array(new SharedArrayBuffer(4));

export function writeFakeSwayTree(controlDir: string, tree: unknown): void {
  const { treePath } = fakeSwayIpcPaths(controlDir);
  const temporary = `${treePath}.${process.pid}.${++treeWriteSequence}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(tree)}\n`);
  renameSync(temporary, treePath);
}

/** CDP, test mapping and IPC commands mutate one tree without lost updates. */
export function updateFakeSwayTree(controlDir: string, update: (tree: unknown) => unknown): void {
  const { treePath } = fakeSwayIpcPaths(controlDir);
  const lockPath = `${treePath}.lock`;
  const deadline = Date.now() + 1_000;
  let lock: number;
  while (true) {
    try { lock = openSync(lockPath, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(treeLockWait, 0, 0, 2);
    }
  }
  try { writeFakeSwayTree(controlDir, update(JSON.parse(readFileSync(treePath, "utf8")) as unknown)); }
  finally { closeSync(lock); unlinkSync(lockPath); }
}

export function writeFakeSwayIpcMode(controlDir: string, mode: FakeSwayIpcMode): void {
  writeFileSync(fakeSwayIpcPaths(controlDir).modePath, `${mode}\n`);
}

export function readFakeSwayCommands(controlDir: string): string[] {
  const { commandsPath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(commandsPath)) return [];
  return readFileSync(commandsPath, "utf8").split("\n").filter((line) => line !== "");
}

/** Subscription lifecycle and event-delivery lines, in arrival order. */
export function readFakeSwaySubscriptions(controlDir: string): string[] {
  const { subscriptionsPath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(subscriptionsPath)) return [];
  return readFileSync(subscriptionsPath, "utf8").split("\n").filter((line) => line !== "");
}

/** Sway window ids the fake pushed to a subscribed socket, in delivery order. */
export function readFakeSwayEventDeliveries(controlDir: string): string[] {
  const { deliveriesPath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(deliveriesPath)) return [];
  return readFileSync(deliveriesPath, "utf8").split("\n").filter((line) => line !== "");
}

/** Pushes a `window` event without touching the tree, e.g. for an already-mapped window. */
export function writeFakeSwayWindowEvent(
  controlDir: string,
  container: Record<string, unknown>,
  change = "new",
): void {
  appendFileSync(fakeSwayIpcPaths(controlDir).eventsPath, `${JSON.stringify({ change, container })}\n`);
}

/**
 * Models a window Sway maps on `workspaceName` (the first workspace when
 * omitted): the container becomes visible to the next `get_tree` and the
 * subscription receives its `window::new` event.
 */
export function mapFakeSwayWindow(
  controlDir: string,
  container: Record<string, unknown>,
  workspaceName?: string,
): void {
  const { treePath } = fakeSwayIpcPaths(controlDir);
  if (existsSync(treePath)) {
    updateFakeSwayTree(controlDir, tree => insertContainer(tree, container, workspaceName));
  }
  writeFakeSwayWindowEvent(controlDir, container, "new");
}

function readMode(controlDir: string): FakeSwayIpcMode {
  const { modePath } = fakeSwayIpcPaths(controlDir);
  if (!existsSync(modePath)) return "ok";
  const mode = readFileSync(modePath, "utf8").trim();
  if (mode === "refuse" || mode === "hang" || mode === "ack" || mode === "refuse-scratchpad" || mode === "ack-route") return mode;
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
  if (readMode(controlDir) === "refuse" || readMode(controlDir) === "refuse-scratchpad" && payload.endsWith(" move scratchpad")) {
    return JSON.stringify([{ success: false, error: "refused" }]);
  }
  const focused = /^\[con_id=(\d+)\] focus$/.exec(payload);
  if (focused !== null && existsSync(treePath) && readMode(controlDir) !== "ack") {
    updateFakeSwayTree(controlDir, tree => markContainerFocused(tree, Number(focused[1])));
  }
  const moved = /^\[con_id=(\d+)\] move container to workspace (\S+)$/.exec(payload);
  if (moved !== null && existsSync(treePath) && readMode(controlDir) !== "ack" && readMode(controlDir) !== "ack-route") {
    updateFakeSwayTree(controlDir, tree => moveContainerToWorkspace(tree, Number(moved[1]), moved[2]!));
  }
  const parked = /^\[con_id=(\d+)\] move scratchpad$/.exec(payload);
  if (parked !== null && existsSync(treePath) && readMode(controlDir) !== "ack") {
    updateFakeSwayTree(controlDir, tree => moveContainerToWorkspace(tree, Number(parked[1]), SCRATCHPAD_WORKSPACE));
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

function insertContainer(
  tree: unknown,
  container: Record<string, unknown>,
  workspaceName: string | undefined,
): unknown {
  if (tree === null || typeof tree !== "object") return tree;
  if (findRecord(tree, (record) => record.id === container.id) !== undefined) return tree;
  const workspace = workspaceName === undefined
    ? findRecord(tree, (record) => record.type === "workspace")
    : findRecord(tree, (record) => record.type === "workspace" && record.name === workspaceName);
  if (workspace === undefined) return tree;
  const key = container.type === "floating_con" ? "floating_nodes" : "nodes";
  if (!Array.isArray(workspace[key])) workspace[key] = [];
  (workspace[key] as unknown[]).push(container);
  return tree;
}

/**
 * Models `move container to workspace` so a routing assertion can re-read a tree
 * the way Sway would report it. A workspace the fixture tree does not have yet
 * is created under the first output, matching a Sway workspace command.
 */
function moveContainerToWorkspace(tree: unknown, containerId: number, workspaceName: string): unknown {
  if (tree === null || typeof tree !== "object") return tree;
  const nextWorkspaceId = highestNodeId(tree) + 1;
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
      // Native ids are driven externally by tests. Keep the synthetic internal
      // scratchpad workspace out of that positive-id namespace.
      id: workspaceName === SCRATCHPAD_WORKSPACE ? -1 : nextWorkspaceId,
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
  const subscriptions = new Set<{ write(data: Uint8Array): unknown; end(): void }>();
  const { eventsPath, subscriptionsPath, deliveriesPath } = fakeSwayIpcPaths(input.controlDir);
  let eventsOffset = existsSync(eventsPath) ? readFileSync(eventsPath).byteLength : 0;
  let dropOffset = 0;
  const broadcastEvents = (): void => {
    const dropPath = path.join(input.controlDir, "drop-subscriptions");
    if (existsSync(dropPath)) {
      const length = readFileSync(dropPath).byteLength;
      if (length > dropOffset) {
        dropOffset = length;
        for (const socket of subscriptions) socket.end();
      }
    }
    if (!existsSync(eventsPath)) return;
    const bytes = readFileSync(eventsPath);
    if (bytes.byteLength <= eventsOffset) return;
    const chunk = bytes.subarray(eventsOffset);
    eventsOffset = bytes.byteLength;
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line === "") continue;
      const message = encodeMessage(SWAY_WINDOW_EVENT, line);
      for (const socket of subscriptions) socket.write(message);
      try {
        const parsed = JSON.parse(line) as { container?: { id?: unknown } };
        if (parsed.container?.id !== undefined) {
          appendFileSync(deliveriesPath, `${String(parsed.container.id)}\n`);
        }
      } catch {
        // A malformed injected event is still delivered; the runtime decides.
      }
    }
  };
  const timer = setInterval(broadcastEvents, 10);
  timer.unref?.();
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
            if (message.type === SWAY_IPC_SUBSCRIBE) {
              appendFileSync(subscriptionsPath, "subscribe\n");
              subscriptions.add(socket);
              socket.write(encodeMessage(SWAY_IPC_SUBSCRIBE, JSON.stringify({ success: true })));
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
      close(socket) {
        if (!subscriptions.delete(socket)) return;
        appendFileSync(subscriptionsPath, "close\n");
      },
    },
  });
  await new Promise(() => {});
}
