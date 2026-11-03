import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import type { ComputerAction } from "../../packages/domain/src/computer.ts";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";
import { BrowserRuntime, type BrowserScreenPort } from "../../apps/daemon/src/modules/computer/browserRuntime.ts";
import { WindowOwnership } from "../../apps/daemon/src/modules/computer/windowOwnership.ts";

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type AxFixtureNode = { nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean; backendDOMNodeId?: number; role?: { value: string }; name?: { value: string }; value?: { value: string }; properties?: { name: string; value: { value: unknown } }[] };

/** A wide, deep page: 50 ignored wrappers x 40 sections x 100 fields, far beyond the old 8 MiB full-tree reply. */
function largeAxTree(): Map<string, AxFixtureNode> {
  const nodes = new Map<string, AxFixtureNode>();
  const root: AxFixtureNode = { nodeId: "1", childIds: [], role: { value: "RootWebArea" }, name: { value: "Fixture" } };
  nodes.set(root.nodeId, root);
  let next = 2;
  let backend = 1000;
  for (let w = 0; w < 50; w++) {
    const wrapper: AxFixtureNode = { nodeId: String(next++), parentId: root.nodeId, ignored: true, role: { value: "generic" }, childIds: [] };
    root.childIds!.push(wrapper.nodeId);
    nodes.set(wrapper.nodeId, wrapper);
    for (let g = 0; g < 40; g++) {
      const section: AxFixtureNode = { nodeId: String(next++), parentId: wrapper.nodeId, backendDOMNodeId: backend++, role: { value: "group" }, name: { value: `Section ${w}.${g}` }, childIds: [] };
      wrapper.childIds!.push(section.nodeId);
      nodes.set(section.nodeId, section);
      for (let i = 0; i < 100; i++) {
        const field: AxFixtureNode = { nodeId: String(next++), parentId: section.nodeId, backendDOMNodeId: backend++, role: { value: "textbox" }, name: { value: `Field ${w}.${g}.${i} ${"label ".repeat(20)}` }, value: { value: "" }, properties: [{ name: "required", value: { value: true } }] };
        section.childIds!.push(field.nodeId);
        nodes.set(field.nodeId, field);
      }
    }
  }
  return nodes;
}

function fixture(
  limits?: ConstructorParameters<typeof CdpPipe>[2],
  /** Seeds the launch claims a live Computer would have made; off means no window is owned. */
  seedOwnership = true,
  holdDiscovery = false,
) {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const log: Command[] = [];
  const input: ComputerAction[] = [];
  const targets = [
    { targetId: "a", type: "page", title: "Screen A", url: "http://fixture/a", windowId: 1 },
    { targetId: "b", type: "page", title: "Screen B", url: "http://fixture/b", windowId: 2 },
  ];
  let text = "Fixture ready";
  let pending = "";
  let onFrame: (() => void) | undefined;
  let hidden = false;
  const selected = new Map([[1, "a"], [2, "b"]]);
  let removed = false;
  let axCount = 1;
  let axTree: Map<string, AxFixtureNode> | undefined;
  const replySizes: number[] = [];
  const smallAxTree = (sessionId?: string): Map<string, AxFixtureNode> => {
    const nodes = new Map<string, AxFixtureNode>();
    const children = Array.from({ length: axCount }, (_, i): AxFixtureNode => ({ nodeId: String(i + 2), parentId: "1", backendDOMNodeId: 42 + i, role: { value: "textbox" }, name: { value: "Name" }, value: { value: "" }, properties: [{ name: "required", value: { value: true } }] }));
    nodes.set("1", { nodeId: "1", childIds: children.map((child) => child.nodeId), role: { value: "RootWebArea" }, name: { value: sessionId === "session-duplicate" ? "Human selected page" : "Fixture" } });
    for (const child of children) nodes.set(child.nodeId, child);
    return nodes;
  };
  let geometry = { innerWidth: 800, innerHeight: 520, clientWidth: 800, clientHeight: 520 };
  const unlocated = new Set<string>();
  const disappearing = new Set<string>();
  commands.on("data", (chunk) => {
    pending += chunk.toString();
    for (;;) {
      const end = pending.indexOf("\0");
      if (end < 0) break;
      const command: Command = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      log.push(command);
      if (holdDiscovery && command.method === "Target.setDiscoverTargets") continue;
      let result: unknown = {};
      if ((hidden || removed) && command.method.startsWith("DOM.")) {
        replies.write(JSON.stringify({ id: command.id, error: { message: removed ? "No node with given id found" : "Could not compute box model." } }) + "\0");
        continue;
      }
      if (command.method === "Browser.getWindowForTarget" && unlocated.has(String(command.params.targetId))) {
        if (disappearing.has(String(command.params.targetId))) {
          const index = targets.findIndex(target => target.targetId === command.params.targetId);
          if (index >= 0) targets.splice(index, 1);
        }
        replies.write(JSON.stringify({ id: command.id, error: { message: "Window unavailable" } }) + "\0");
        continue;
      }
      switch (command.method) {
        case "SystemInfo.getProcessInfo": result = { processInfo: [{ type: "browser", id: 100 }] }; break;
        case "Target.getTargets": result = { targetInfos: targets }; break;
        case "Browser.getWindowForTarget": {
          const windowId = targets.find((target) => target.targetId === command.params.targetId)?.windowId;
          result = { windowId, bounds: { left: windowId === 1 ? 10 : 8202, top: 20, width: 800, height: 600 } };
          break;
        }
        case "Target.attachToTarget": result = { sessionId: `session-${command.params.targetId}` }; break;
        case "Accessibility.getFullAXTree": result = { nodes: [...(axTree ?? smallAxTree(command.sessionId)).values()] }; break;
        case "Accessibility.getRootAXNode": result = { node: (axTree ?? smallAxTree(command.sessionId)).get("1") }; break;
        case "Accessibility.getChildAXNodes": {
          const tree = axTree ?? smallAxTree(command.sessionId);
          const parent = tree.get(String(command.params.id));
          if (!parent) { replies.write(JSON.stringify({ id: command.id, error: { message: "Invalid ID" } }) + "\0"); continue; }
          result = { nodes: (parent.childIds ?? []).map((id) => tree.get(id)!) };
          break;
        }
        case "Page.getFrameTree": result = { frameTree: { frame: { id: "main", loaderId: "load1" } } }; break;
        case "Page.createIsolatedWorld": result = { executionContextId: 123 }; break;
        case "Runtime.evaluate": {
          const target = targets.find(target => `session-${target.targetId}` === command.sessionId);
          const expression = String(command.params.expression);
          result = { result: { value: expression.includes("document.visibilityState") ? selected.get(target!.windowId) === target!.targetId : expression.startsWith("new Promise") ? true : runInNewContext(expression, { innerWidth: geometry.innerWidth, innerHeight: geometry.innerHeight, document: { body: { innerText: text }, documentElement: { textContent: text } } }) } };
          break;
        }
        case "Target.activateTarget": {
          const target = targets.find(target => target.targetId === command.params.targetId)!;
          selected.set(target.windowId, target.targetId);
          break;
        }
        case "DOM.resolveNode": result = { object: { objectId: "isolated-element" } }; break;
        case "Runtime.callFunctionOn": {
          const declaration = String(command.params.functionDeclaration);
          if (!declaration.includes("this.options")) { result = { result: { value: text } }; break; }
          const select = { tagName: "SELECT", multiple: false, options: [
            { value: "grey", label: "Grey", disabled: true, parentElement: { tagName: "SELECT" } },
            { value: "red", label: "Red", disabled: false, parentElement: { tagName: "SELECT" } },
            { value: "blue", label: "Blue", disabled: false, parentElement: { tagName: "SELECT" } },
          ] };
          const args = (command.params.arguments as { value: unknown }[] | undefined ?? []).map((arg) => arg.value);
          result = { result: { value: (runInNewContext(`(${declaration})`) as (...args: unknown[]) => unknown).apply(select, args) } };
          break;
        }
        case "Page.getNavigationHistory": result = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] }; break;
        case "Target.closeTarget": {
          const index = targets.findIndex((target) => target.targetId === command.params.targetId);
          if (index >= 0) {
            const [closed] = targets.splice(index, 1);
            const next = targets.find(target => target.windowId === closed!.windowId);
            if (next) selected.set(next.windowId, next.targetId);
          }
          result = { success: true };
          break;
        }
        case "DOM.getBoxModel": result = { model: { content: [20, 30, 120, 30, 120, 70, 20, 70] } }; break;
        case "Page.getLayoutMetrics": result = { cssLayoutViewport: { clientWidth: geometry.clientWidth, clientHeight: geometry.clientHeight, pageX: 0, pageY: 0 } }; break;
      }
      const reply = JSON.stringify({ id: command.id, result }) + "\0";
      replySizes.push(Buffer.byteLength(reply));
      replies.write(reply);
      if (command.method === "Page.getFrameTree") onFrame?.();
    }
  });
  const cdp = new CdpPipe(commands, replies, limits);
  const ownership = new WindowOwnership();
  if (seedOwnership) {
    ownership.register("screen-a", "window-a", 1, "a");
    ownership.register("screen-b", "window-b", 2, "b");
  }
  const runtime = new BrowserRuntime(cdp, ownership);
  const port = (screen: "a" | "b"): BrowserScreenPort => ({
    windows: async () => [{ id: `window-${screen}`, pid: 100, title: `Screen ${screen.toUpperCase()} - Chromium`, focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } }],
    focusWindow: async () => {},
    input: async (action) => {
      input.push(action);
      if (action.name === "key" && action.args.key === "Ctrl+t") {
        const windowId = screen === "a" ? 1 : 2;
        targets.push({ targetId: "new", type: "page", title: "New tab", url: "about:blank", windowId });
        selected.set(windowId, "new");
      }
    },
  });
  return { runtime, ownership, cdp, log, releaseDiscovery: () => {
    const discovery = log.find(command => command.method === "Target.setDiscoverTargets");
    if (!discovery) throw new Error("Discovery was not requested");
    replies.write(JSON.stringify({ id: discovery.id, result: {} }) + "\0");
  }, input, targets, replies, port, selected, unlocated, disappearing, setGeometry: (value: typeof geometry) => { geometry = value; }, setText: (value: string) => { text = value; }, onFrame: (callback: () => void) => { onFrame = callback; }, hide: () => { hidden = true; }, remove: () => { removed = true; }, manyNodes: () => { axCount = 400; }, setAxTree: (tree: Map<string, AxFixtureNode>) => { axTree = tree; }, replySizes };
}

test("snapshot owns only the routed Screen and new snapshots invalidate element refs", async () => {
  const f = fixture();
  try {
    const first = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(first.text).toContain('textbox "Name"');
    expect(first.text).toContain("required=true");
    const ref = first.text.match(/\[(e[^\]]+)\]/)![1]!;
    await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    await expect(f.runtime.perform("screen-a", { name: "click", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
    const tabs = await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "list" } }, f.port("a"));
    expect(tabs.text).toContain("http://fixture/a");
    expect(tabs.text).not.toContain("http://fixture/b");
    await expect(f.runtime.perform("screen-a", { name: "tabs", args: { operation: "switch", tabId: "b" } }, f.port("a"))).rejects.toThrow("Screen");
    expect(f.log.some((command) => command.method === "Runtime.enable")).toBe(false);
  } finally { f.runtime.close(); }
});

test.each(["removed", "browser window changed", "target changed", "owner changed"])("scope pruning preserves a registration that was %s during native observation", async (change) => {
  const f = fixture();
  const port: BrowserScreenPort = {
    ...f.port("a"),
    windows: async () => {
      f.ownership.releaseWindow("screen-a", "window-a");
      if (change !== "removed") {
        f.ownership.register(change === "owner changed" ? "screen-b" : "screen-a", "window-a", change === "browser window changed" ? 3 : 1, change === "target changed" ? "replacement" : "a");
      }
      return [];
    },
  };
  try {
    await expect(f.runtime.perform("screen-a", { name: "tabs", args: {} }, port)).rejects.toThrow("No browser window belongs to this Screen");
    expect(f.ownership.ownerOfBrowserWindow(change === "browser window changed" ? 3 : 1)).toEqual(change === "removed" ? undefined : {
      surfaceId: change === "owner changed" ? "screen-b" : "screen-a",
      swayWindowId: "window-a",
      browserWindowId: change === "browser window changed" ? 3 : 1,
      targetId: change === "target changed" ? "replacement" : "a",
    });
  } finally { f.runtime.close(); }
});

test("click, type and select use Screen input and isolated read-only page scripts", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    await f.runtime.perform("screen-a", { name: "click", args: { ref } }, f.port("a"));
    await f.runtime.perform("screen-a", { name: "type", args: { ref, text: "Ada" } }, f.port("a"));
    await f.runtime.perform("screen-a", { name: "select", args: { ref, value: "Blue" } }, f.port("a"));
    expect(f.input).toEqual([
      { name: "click", args: { x: 80, y: 150 } },
      { name: "click", args: { x: 80, y: 150 } },
      { name: "type", args: { text: "Ada" } },
      { name: "click", args: { x: 80, y: 150 } },
      { name: "key", args: { key: "Home" } },
      { name: "key", args: { key: "Down" } },
      { name: "key", args: { key: "Enter" } },
    ]);
    expect((await f.runtime.perform("screen-a", { name: "read_text", args: { ref } }, f.port("a"))).text).toBe("Fixture ready");
    expect((await f.runtime.perform("screen-a", { name: "read_text", args: {} }, f.port("a"))).text).toBe("Fixture ready");
    for (const command of f.log.filter((command) => command.method === "Runtime.evaluate")) expect(command.params.contextId).toBe(123);
    for (const command of f.log.filter((command) => command.method === "DOM.resolveNode")) expect(command.params.executionContextId).toBe(123);
    expect(f.log.some((command) => command.method === "Runtime.enable")).toBe(false);
  } finally { f.runtime.close(); }
});

test("Screen isolation survives identical titles and refs never cross Screens", async () => {
  const f = fixture();
  f.targets[0]!.title = "about:blank";
  f.targets[1]!.title = "about:blank";
  const port = (screen: "a" | "b"): BrowserScreenPort => ({
    ...f.port(screen), windows: async () => [{ id: `window-${screen}`, pid: 100, title: "about:blank - Chromium", focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } }],
  });
  try {
    f.ownership.register("screen-a", "window-a", 1, "a");
    const a = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, port("a"));
    await f.runtime.perform("screen-b", { name: "snapshot", args: {} }, port("b"));
    const ref = a.text.match(/\[(e[^\]]+)\]/)![1]!;
    await expect(f.runtime.perform("screen-b", { name: "click", args: { ref } }, port("b"))).rejects.toThrow("new snapshot");
    const tabs = await f.runtime.perform("screen-b", { name: "tabs", args: { operation: "list" } }, port("b"));
    expect(tabs.text).toContain("http://fixture/b");
    expect(tabs.text).not.toContain("http://fixture/a");
    const moved = { ...port("a"), windows: async () => [] };
    await expect(f.runtime.perform("screen-a", { name: "snapshot", args: {} }, moved)).rejects.toThrow("no longer routed");
    expect(f.log.filter((command) => command.method === "Target.detachFromTarget").length).toBeGreaterThan(0);
  } finally { f.runtime.close(); }
});

test("navigation, back, tabs and event-driven stale refs stay in the owned window", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    await f.runtime.perform("screen-a", { name: "navigate", args: { url: "http://fixture/new" } }, f.port("a"));
    await expect(f.runtime.perform("screen-a", { name: "click", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
    await f.runtime.perform("screen-a", { name: "back", args: {} }, f.port("a"));
    await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "open", url: "http://fixture/tab" } }, f.port("a"));
    expect(f.input).toContainEqual({ name: "key", args: { key: "Ctrl+t" } });
    await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "switch", tabId: "new" } }, f.port("a"));
    await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "close", tabId: "new" } }, f.port("a"));
    expect(f.targets.some((target) => target.targetId === "new")).toBe(false);
    const fresh = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const freshRef = fresh.text.match(/\[(e[^\]]+)\]/)![1]!;
    f.replies.write(JSON.stringify({ method: "Page.frameNavigated", sessionId: "session-a", params: { frame: { id: "main" } } }) + "\0");
    await expect(f.runtime.perform("screen-a", { name: "read_text", args: { ref: freshRef } }, f.port("a"))).rejects.toThrow("new snapshot");
    await expect(f.runtime.perform("screen-a", { name: "navigate", args: { url: "javascript:alert(1)" } }, f.port("a"))).rejects.toThrow("URL");
  } finally { f.runtime.close(); }
});

test("wait_for text/ref/navigation has a bounded deadline and abort/drop/close cancel work", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    expect((await f.runtime.perform("screen-a", { name: "wait_for", args: { text: "ready" } }, f.port("a"))).text).toBe("Text found");
    expect((await f.runtime.perform("screen-a", { name: "wait_for", args: { ref } }, f.port("a"))).text).toContain("present");
    await expect(f.runtime.perform("screen-a", { name: "wait_for", args: { text: "absent", timeoutMs: 10 } }, f.port("a"))).rejects.toThrow("timed out");
    await expect(f.runtime.perform("screen-a", { name: "wait_for", args: { text: "x", ref } }, f.port("a"))).rejects.toThrow("exactly one");
    await expect(f.runtime.perform("screen-a", { name: "wait_for", args: { navigation: true, timeoutMs: 30001 } }, f.port("a"))).rejects.toThrow("30000");
    const abort = new AbortController();
    const pending = f.runtime.perform("screen-a", { name: "wait_for", args: { navigation: true } }, f.port("a"), abort.signal);
    abort.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    const dropped = f.runtime.perform("screen-a", { name: "wait_for", args: { text: "absent" } }, f.port("a"));
    f.runtime.dropScreen("screen-a");
    await expect(dropped).rejects.toThrow("Screen closed");
    f.runtime.close();
    await expect(f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"))).rejects.toThrow("closed");
  } finally { f.runtime.close(); }
});

for (const cancellation of ["caller", "Screen closure", "deadline"] as const) test(`shared target discovery respects ${cancellation} while another caller stays live`, async () => {
  const f = fixture(undefined, true, true);
  try {
    const abort = new AbortController();
    const waiting = f.runtime.perform("screen-a", cancellation === "deadline"
      ? { name: "wait_for", args: { text: "ready", timeoutMs: 10 } }
      : { name: "tabs", args: {} }, f.port("a"), abort.signal)
      .then(() => "unexpected success", error => (error as Error).message);
    let liveSettled = false;
    const live = f.runtime.perform("screen-b", { name: "tabs", args: {} }, f.port("b"))
      .then(result => { liveSettled = true; return result.text; }, error => { liveSettled = true; return String(error); });
    if (cancellation === "caller") abort.abort(new Error("cancelled discovery wait"));
    if (cancellation === "Screen closure") f.runtime.dropScreen("screen-a");
    const expected = cancellation === "caller" ? "cancelled discovery wait"
      : cancellation === "Screen closure" ? "Browser Screen closed" : "Browser wait_for timed out after 10ms";
    expect(await Promise.race([waiting, Bun.sleep(250).then(() => "discovery wait did not settle promptly")])).toBe(expected);
    expect(liveSettled).toBe(false);
    expect(f.log.filter(command => command.method === "Target.setDiscoverTargets")).toHaveLength(1);
    expect(f.log.some(command => command.method === "Target.getTargets")).toBe(false);
    f.releaseDiscovery();
    expect(await live).toContain("http://fixture/b");
    expect(f.cdp.alive).toBe(true);
    expect(f.log.filter(command => command.method === "Target.setDiscoverTargets")).toHaveLength(1);
  } finally { f.runtime.close(); }
});

test("page text caps preserve UTF8 boundaries", async () => {
  const f = fixture();
  try {
    f.setText("猫".repeat(4000));
    const text = await f.runtime.perform("screen-a", { name: "read_text", args: {} }, f.port("a"));
    expect(text.truncated).toBe(true);
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(8192);
    expect(text.text).not.toContain("�");
  } finally { f.runtime.close(); }
});

test("wait_for observes navigation and target destruction detaches scoped refs", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    let frameReads = 0;
    f.onFrame(() => {
      if (++frameReads === 2) f.replies.write(JSON.stringify({ method: "Page.frameNavigated", sessionId: "session-a", params: { frame: { id: "main" } } }) + "\0");
    });
    const waiting = f.runtime.perform("screen-a", { name: "wait_for", args: { navigation: true, timeoutMs: 1000 } }, f.port("a"));
    expect((await waiting).text).toBe("Navigation observed");
    await expect(f.runtime.perform("screen-a", { name: "read_text", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
    const next = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const nextRef = next.text.match(/\[(e[^\]]+)\]/)![1]!;
    f.replies.write(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "session-a" } }) + "\0");
    await expect(f.runtime.perform("screen-a", { name: "read_text", args: { ref: nextRef } }, f.port("a"))).rejects.toThrow("new snapshot");
    expect(f.log.filter((command) => command.method === "Target.attachToTarget").length).toBe(2);
  } finally { f.runtime.close(); }
});

test("a browser window no launch claimed is never adopted by its title", async () => {
  const f = fixture(undefined, false);
  f.targets[1]!.title = "Screen A";
  const port = f.port("a");
  try {
    await expect(f.runtime.perform("screen-a", { name: "snapshot", args: {} }, port)).rejects
      .toThrow("open the page with `browser tabs open` or `open_url` from this Screen");
    expect(f.log.some((command) => command.method === "Target.attachToTarget")).toBe(false);
    f.ownership.register("screen-a", "window-a", 1, "a");
    expect(() => f.ownership.register("screen-b", "window-b", 1, "a")).toThrow("another Screen");
    expect((await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, port)).text).toContain("Name");
  } finally { f.runtime.close(); }
});

test("snapshot preserves AX hierarchy and caps node output", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(snapshot.text).toMatch(/RootWebArea "Fixture"\n  \[e\d+\] textbox/);
    f.manyNodes();
    const large = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(large.truncated).toBe(true);
    expect(large.text.split("\n").length).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(large.text)).toBeLessThanOrEqual(16384);
  } finally { f.runtime.close(); }
});

test("snapshot of a huge page walks the AX tree within caps and reports truncation", async () => {
  const f = fixture();
  const tree = largeAxTree();
  // The old single getFullAXTree reply for this page would exceed the 8 MiB CDP frame limit.
  expect(Buffer.byteLength(JSON.stringify({ id: 1, result: { nodes: [...tree.values()] } }))).toBeGreaterThan(8 * 1024 * 1024);
  f.setAxTree(tree);
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.split("\n").length).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(16384);
    // Ignored wrappers are skipped but their descendants keep document order and hierarchy.
    expect(snapshot.text).toMatch(/^RootWebArea "Fixture"\n  \[e\d+\] group "Section 0\.0"\n    \[e\d+\] textbox "Field 0\.0\.0 /);
    expect(f.log.some((command) => command.method === "Accessibility.getFullAXTree")).toBe(false);
    expect(f.log.filter((command) => command.method === "Accessibility.getChildAXNodes").length).toBeLessThan(20);
    expect(Math.max(...f.replySizes)).toBeLessThan(256 * 1024);
    expect(f.log.findLast((command) => command.method.startsWith("Accessibility."))?.method).toBe("Accessibility.disable");
    // Refs from the walk act like refs from the old full-tree snapshot.
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    expect((await f.runtime.perform("screen-a", { name: "read_text", args: { ref } }, f.port("a"))).text).toBe("Fixture ready");
  } finally { f.runtime.close(); }
});

test("an oversized child list truncates only that snapshot and the shared pipe keeps serving every Screen", async () => {
  const f = fixture({ maxFrameBytes: 64 * 1024 });
  const tree = new Map<string, AxFixtureNode>();
  const huge: AxFixtureNode = { nodeId: "2", parentId: "1", role: { value: "list" }, name: { value: "Huge" }, childIds: [] };
  tree.set("1", { nodeId: "1", childIds: ["2", "3"], role: { value: "RootWebArea" }, name: { value: "Fixture" } });
  tree.set("2", huge);
  tree.set("3", { nodeId: "3", parentId: "1", backendDOMNodeId: 7, role: { value: "button" }, name: { value: "After" } });
  for (let i = 0; i < 2000; i++) {
    tree.set(`h${i}`, { nodeId: `h${i}`, parentId: "2", role: { value: "listitem" }, name: { value: "item ".repeat(20) } });
    huge.childIds!.push(`h${i}`);
  }
  f.setAxTree(tree);
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toContain('list "Huge"');
    expect(snapshot.text).toContain('button "After"');
    expect(snapshot.text).not.toContain("listitem");
    expect(f.cdp.alive).toBe(true);
    expect((await f.runtime.perform("screen-b", { name: "read_text", args: {} }, f.port("b"))).text).toBe("Fixture ready");
    // When nothing at all fits, the snapshot fails with the actionable message instead of an empty result.
    tree.set("1", { nodeId: "1", ignored: true, childIds: [...huge.childIds!], role: { value: "RootWebArea" } });
    await expect(f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"))).rejects.toThrow("page too large for a snapshot; narrow with read_text/wait_for or take a smaller snapshot");
    expect(f.cdp.alive).toBe(true);
    tree.set("1", { nodeId: "1", childIds: ["3"], role: { value: "RootWebArea" }, name: { value: "Fixture" } });
    expect((await f.runtime.perform("screen-b", { name: "snapshot", args: {} }, f.port("b"))).text).toContain('button "After"');
  } finally { f.runtime.close(); }
});

test("removed DOM nodes request a new snapshot and hidden refs wait until deadline", async () => {
  const f = fixture();
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = snapshot.text.match(/\[(e[^\]]+)\]/)![1]!;
    f.hide();
    await expect(f.runtime.perform("screen-a", { name: "wait_for", args: { ref, timeoutMs: 10 } }, f.port("a"))).rejects.toThrow("timed out");
    f.remove();
    await expect(f.runtime.perform("screen-a", { name: "click", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
    await expect(f.runtime.perform("screen-a", { name: "read_text", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
  } finally { f.runtime.close(); }
});

test("registered launches expose every routed browser window and focus the selected tab window", async () => {
  const f = fixture(undefined, false);
  const focused: string[] = [];
  const port: BrowserScreenPort = {
    ...f.port("a"),
    windows: async () => [
      { id: "window-a", pid: 100, title: "Screen A - Chromium", focused: false, bounds: { x: 10, y: 20, width: 800, height: 600 } },
      { id: "window-second", pid: 100, title: "Screen B - Chromium", focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } },
    ],
    focusWindow: async (window) => { focused.push(window.id); },
  };
  try {
    f.ownership.register("screen-a", "window-a", 1, "a");
    f.ownership.register("screen-a", "window-second", 2, "b");
    const tabs = await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "list" } }, port);
    expect(tabs.text).toContain("http://fixture/a");
    expect(tabs.text).toContain("http://fixture/b");
    await f.runtime.perform("screen-a", { name: "tabs", args: { operation: "switch", tabId: "a" } }, port);
    expect(focused).toEqual(["window-a"]);
    expect(() => f.ownership.register("screen-b", "window-b", 2, "b")).toThrow("another Screen");
  } finally { f.runtime.close(); }
});

test("aborted target attachment detaches the eventual session", async () => {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const cdp = new CdpPipe(commands, replies);
  const ownership = new WindowOwnership();
  ownership.register("screen", "window", 1, "a");
  const runtime = new BrowserRuntime(cdp, ownership);
  const attached = Promise.withResolvers<Command>();
  const detached = Promise.withResolvers<Command>();
  let pending = "";
  commands.on("data", (chunk) => {
    pending += chunk.toString();
    while (pending.includes("\0")) {
      const end = pending.indexOf("\0");
      const command: Command = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (command.method === "Target.attachToTarget") { attached.resolve(command); continue; }
      if (command.method === "Target.detachFromTarget") detached.resolve(command);
      const result = command.method === "Target.getTargets" ? { targetInfos: [{ targetId: "a", type: "page", title: "Owned", url: "about:blank" }] }
        : command.method === "SystemInfo.getProcessInfo" ? { processInfo: [{ type: "browser", id: 100 }] }
        : command.method === "Browser.getWindowForTarget" ? { windowId: 1, bounds: { width: 800, height: 600 } } : {};
      replies.write(JSON.stringify({ id: command.id, result }) + "\0");
    }
  });
  try {
    const abort = new AbortController();
    const port: BrowserScreenPort = {
      windows: async () => [{ id: "window", pid: 100, title: "Owned - Chromium", focused: true, bounds: { x: 0, y: 0, width: 800, height: 600 } }],
      focusWindow: async () => {}, input: async () => {},
    };
    const action = runtime.perform("screen", { name: "snapshot", args: {} }, port, abort.signal);
    const command = await attached.promise;
    abort.abort(new Error("cancelled attachment"));
    await expect(action).rejects.toThrow("cancelled attachment");
    replies.write(JSON.stringify({ id: command.id, result: { sessionId: "late-session" } }) + "\0");
    expect((await detached.promise).params).toEqual({ sessionId: "late-session" });
  } finally { runtime.close(); }
});

test("unrelated routed app title cannot adopt another Screen browser", async () => {
  const f = fixture();
  f.targets[1]!.title = "Orders";
  const port: BrowserScreenPort = {
    ...f.port("a"),
    windows: async () => [
      { id: "window-a", pid: 100, appId: "chromium", title: "Screen A - Chromium", focused: false, bounds: { x: 10, y: 20, width: 800, height: 600 } },
      { id: "orders-app", pid: 200, appId: "orders", title: "Orders", focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } },
    ],
  };
  try {
    const tabs = await f.runtime.perform("screen-a", { name: "tabs", args: {} }, port);
    expect(tabs.text).toContain("http://fixture/a");
    expect(tabs.text).not.toContain("http://fixture/b");
    await expect(f.runtime.perform("screen-a", { name: "tabs", args: { operation: "close", tabId: "b" } }, port)).rejects.toThrow("Screen");
    expect(f.targets.some(target => target.targetId === "b")).toBe(true);
  } finally { f.runtime.close(); }
});

test("fresh snapshot follows human selected tab with duplicate titles and expires old refs", async () => {
  const f = fixture();
  f.targets.push({ targetId: "duplicate", type: "page", title: "Screen A", url: "http://fixture/selected", windowId: 1 });
  try {
    const before = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    const ref = before.text.match(/\[(e[^\]]+)\]/)![1]!;
    f.selected.set(1, "duplicate");
    await expect(f.runtime.perform("screen-a", { name: "click", args: { ref } }, f.port("a"))).rejects.toThrow("new snapshot");
    const fresh = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    expect(fresh.text).toContain("Human selected page");
    expect(f.input).toEqual([]);
  } finally { f.runtime.close(); }
});

test("wait_for finds text beyond the read_text output cap", async () => {
  const f = fixture();
  f.setText("x".repeat(8192) + "Ready");
  try {
    const read = await f.runtime.perform("screen-a", { name: "read_text", args: {} }, f.port("a"));
    expect(read.truncated).toBe(true);
    expect(read.text).not.toContain("Ready");
    expect((await f.runtime.perform("screen-a", { name: "wait_for", args: { text: "Ready", timeoutMs: 100 } }, f.port("a"))).text).toBe("Text found");
  } finally { f.runtime.close(); }
});

for (const zoom of [1, 1.25]) test(`non-overlay scrollbars do not alter click coordinates at zoom ${zoom}`, async () => {
  const f = fixture();
  f.setGeometry({ innerWidth: 800 / zoom, innerHeight: 520 / zoom, clientWidth: (800 - 15) / zoom, clientHeight: (520 - 15) / zoom });
  try {
    const snapshot = await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"));
    await f.runtime.perform("screen-a", { name: "click", args: { ref: snapshot.text.match(/\[(e[^\]]+)\]/)![1]! } }, f.port("a"));
    expect(f.input).toEqual([{ name: "click", args: { x: zoom === 1 ? 80 : 98, y: zoom === 1 ? 150 : 163 } }]);
  } finally { f.runtime.close(); }
});

test("a Screen with no bound browser window is told how to open the page", async () => {
  const f = fixture(undefined, false);
  for (const target of f.targets) target.title = "Orders";
  const port = (screen: "a" | "b"): BrowserScreenPort => ({
    ...f.port(screen),
    windows: async () => [{ id: `window-${screen}`, pid: 100, appId: "chromium", title: "Orders - Chromium", focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } }],
  });
  try {
    for (const screen of ["a", "b"] as const) {
      await expect(f.runtime.perform(`screen-${screen}`, { name: "tabs", args: {} }, port(screen))).rejects.toThrow("No browser window belongs to this Screen; open the page with `browser tabs open` or `open_url` from this Screen");
      await expect(f.runtime.perform(`screen-${screen}`, { name: "navigate", args: { url: "http://fixture/unsafe" } }, port(screen))).rejects.toThrow("open_url");
      await expect(f.runtime.perform(`screen-${screen}`, { name: "tabs", args: { operation: "close", tabId: screen === "a" ? "b" : "a" } }, port(screen))).rejects.toThrow("open_url");
    }
    expect(f.targets).toHaveLength(2);
    expect(f.input).toEqual([]);
    expect(f.log.some((command) => command.method === "Target.attachToTarget")).toBe(false);
  } finally { f.runtime.close(); }
});

test("an unlocatable live browser target fails closed instead of scoping a Screen", async () => {
  const f = fixture();
  for (const target of f.targets) target.title = "Orders";
  f.unlocated.add("a");
  const port: BrowserScreenPort = {
    ...f.port("a"),
    windows: async () => [{ id: "window-a", pid: 100, title: "Orders - Chromium", focused: true, bounds: { x: 10, y: 20, width: 800, height: 600 } }],
  };
  try {
    await expect(f.runtime.perform("screen-a", { name: "tabs", args: {} }, port)).rejects.toThrow("ownership");
    await expect(f.runtime.perform("screen-a", { name: "navigate", args: { url: "http://fixture/unsafe" } }, port)).rejects.toThrow("ownership");
    expect(f.input).toEqual([]);
    expect(f.log.some(command => command.method === "Target.attachToTarget")).toBe(false);
  } finally { f.runtime.close(); }
});

test("a destroyed target during window lookup does not prevent a surviving Screen snapshot", async () => {
  const f = fixture();
  f.unlocated.add("b");
  f.disappearing.add("b");
  try {
    expect((await f.runtime.perform("screen-a", { name: "snapshot", args: {} }, f.port("a"))).text).toContain("Fixture");
  } finally { f.runtime.close(); }
});
