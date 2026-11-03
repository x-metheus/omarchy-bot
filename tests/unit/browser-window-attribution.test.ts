import { expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { BrowserRuntime, type BrowserWindowAttributionPort } from "../../apps/daemon/src/modules/computer/browserRuntime.ts";
import { CdpPipe } from "../../apps/daemon/src/modules/computer/cdpPipe.ts";
import { WindowOwnership } from "../../apps/daemon/src/modules/computer/windowOwnership.ts";

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
function fixture() {
  const commands = new PassThrough();
  const replies = new PassThrough();
  const log: Command[] = [];
  const ownership = new WindowOwnership();
  const pages = new Map([
    ["a", { windowId: 101, title: "Same real title", swayWindowId: "41" }],
    ["b", { windowId: 102, title: "Same real title", swayWindowId: "42" }],
  ]);
  const refused = new Set<string>();
  const sessions = new Map<string, string>();
  const documents = new Map<string, object>();
  const contexts = new Map<number, object>();
  let nextContext = 0;
  let nextSession = 0;
  let intercept: ((command: Command) => boolean) | undefined;
  let buffer = "";
  const event = (method: string, params: object, sessionId?: string) => replies.write(JSON.stringify({ method, params, sessionId }) + "\0");
  const reply = (command: Command, result: unknown) => replies.write(JSON.stringify({ id: command.id, result }) + "\0");
  commands.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\0");
      if (end < 0) break;
      const command: Command = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      log.push(command);
      if (intercept?.(command)) continue;
      const targetId = sessions.get(command.sessionId ?? "");
      const page = pages.get(targetId ?? "");
      try {
        let result: unknown = {};
        switch (command.method) {
          case "Target.getTargets": result = { targetInfos: [...pages].map(([targetId, page]) => ({ targetId, type: "page", title: page.title, url: "about:blank" })) }; break;
          case "Browser.getWindowForTarget": result = { windowId: pages.get(String(command.params.targetId))?.windowId }; break;
          case "Target.attachToTarget": {
            const sessionId = `stamp-${++nextSession}`;
            sessions.set(sessionId, String(command.params.targetId));
            result = { sessionId }; break;
          }
          case "Page.getFrameTree": result = { frameTree: { frame: { id: `frame-${targetId}` } } }; break;
          case "Page.createIsolatedWorld": {
            const contextId = ++nextContext;
            let document = documents.get(targetId!);
            if (!document) {
              document = { get title() { return page!.title; }, set title(title: string) { if (!refused.has(targetId!)) page!.title = title; } };
              documents.set(targetId!, document);
            }
            contexts.set(contextId, document);
            result = { executionContextId: contextId }; break;
          }
          case "Runtime.evaluate": {
            const document = contexts.get(Number(command.params.contextId));
            if (!document || !page) throw new Error("Document gone");
            result = { result: { value: runInNewContext(String(command.params.expression), { document }) } }; break;
          }
        }
        reply(command, result);
      } catch (error) {
        replies.write(JSON.stringify({ id: command.id, error: { message: String(error) } }) + "\0");
      }
    }
  });
  const cdp = new CdpPipe(commands, replies);
  const runtime = new BrowserRuntime(cdp, ownership, { stampTimeoutMs: 30 });
  const routed: string[] = [];
  const parked: string[] = [];
  const observed: string[] = [];
  const port: BrowserWindowAttributionPort = {
    observeTitle: async (nonce, signal) => {
      signal.throwIfAborted();
      observed.push(nonce);
      const page = [...pages.values()].find(page => page.title === nonce);
      if (!page) throw new Error("No exact stamp observed");
      return { swayWindowId: page.swayWindowId, title: page.title };
    },
    routeAndVerify: async (surfaceId, swayWindowId, signal) => {
      signal.throwIfAborted();
      expect([...pages.values()].find(page => page.swayWindowId === swayWindowId)?.title).toBe("Same real title");
      expect(ownership.ownerOfSwayWindow(swayWindowId)).toBeUndefined();
      routed.push(`${surfaceId}:${swayWindowId}`);
    },
    park: async (swayWindowId) => { parked.push(swayWindowId); },
  };
  return { runtime, ownership, pages, refused, log, port, routed, parked, observed, event, reply, sessions, intercept: (fn: typeof intercept) => { intercept = fn; } };
}

function pending(f: ReturnType<typeof fixture>, surfaceId = "A", targetId = "a", createdAt?: number) {
  const page = f.pages.get(targetId)!;
  f.ownership.markParked(page.swayWindowId);
  return f.ownership.recordPendingTarget(surfaceId, targetId, createdAt);
}

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("Deterministic fixture barrier was never reached");
}

test("title stamps identify simultaneous targets with equal titles and restore before routing", async () => {
  const f = fixture();
  try {
    const a = pending(f, "A", "a", 0);
    const b = pending(f, "B", "b");
    expect(f.ownership.pendingTargets()).toHaveLength(2);
    const [first, second] = await Promise.all([
      f.runtime.attributeTarget(a, f.port), f.runtime.attributeTarget(b, f.port),
    ]);
    expect(first).toMatchObject({ surfaceId: "A", swayWindowId: "41", browserWindowId: 101, targetId: "a" });
    expect(second).toMatchObject({ surfaceId: "B", swayWindowId: "42", browserWindowId: 102, targetId: "b" });
    expect(new Set(f.observed).size).toBe(2);
    expect(f.routed.sort()).toEqual(["A:41", "B:42"]);
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.pages.get("b")!.title).toBe("Same real title");
    const evaluations = f.log.filter(command => command.method === "Runtime.evaluate");
    expect(evaluations.length).toBeGreaterThanOrEqual(6);
    expect(evaluations.every(command => Number.isInteger(command.params.contextId))).toBe(true);
    expect(f.log.some(command => command.method === "Runtime.enable" || command.method === "Target.activateTarget")).toBe(false);
    expect(f.log.filter(command => command.method === "Target.detachFromTarget")).toHaveLength(2);
  } finally { f.runtime.close(); }
});

test("the pinned pack native title decoration preserves exact stamp identity and restoration", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const observe = f.port.observeTitle;
    f.port.observeTitle = async (nonce, signal) => {
      const observation = await observe(nonce, signal);
      return { ...observation, title: `${observation.title} - Google Chrome for Testing` };
    };
    expect(await f.runtime.attributeTarget(candidate, f.port)).toMatchObject({ surfaceId: "A", swayWindowId: "41", targetId: "a" });
    expect(f.observed).toHaveLength(1);
    expect(f.routed).toEqual(["A:41"]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { f.runtime.close(); }
});

test.each([
  (nonce: string) => `${nonce} - Chromium`,
  (nonce: string) => `${nonce} - Google Chrome`,
  (nonce: string) => `prefix ${nonce}`,
  (nonce: string) => `${nonce} suffix`,
  (nonce: string) => `prefix ${nonce} - Google Chrome for Testing`,
  (nonce: string) => `${nonce} - Google Chrome for Testing suffix`,
  (nonce: string) => `${nonce} - Google Chrome for Testing - Google Chrome for Testing`,
  (nonce: string) => `${nonce.slice(0, -1)} - Google Chrome for Testing`,
  (nonce: string) => `${nonce}-wrong - Google Chrome for Testing`,
])("an inexact observed title is never an identity match and retries exactly once (%#)", async nativeTitle => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const nonces: string[] = [];
    f.port.observeTitle = async nonce => { nonces.push(nonce); return { swayWindowId: "41", title: nativeTitle(nonce) }; };
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toMatchObject({ name: "BrowserWindowAttributionError" });
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(2);
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.routed).toEqual([]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
  } finally { f.runtime.close(); }
});

test("a refusing page returns a retryable error after two bounded observations", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.refused.add("a");
    let attempts = 0;
    f.port.observeTitle = async (_nonce, signal) => {
      attempts++;
      expect(f.pages.get("a")!.title).toBe("Same real title");
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    let failure: unknown;
    try { await f.runtime.attributeTarget(candidate, f.port); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "BrowserWindowAttributionError" });
    expect(failure).toMatchObject({ retryable: true, targetId: "a" });
    expect((failure as Error).message).toContain("retry");
    expect(attempts).toBe(2);
    expect(f.ownership.isParked("41")).toBe(true);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.ownership.pendingTargets()).toEqual([]);
  } finally { f.runtime.close(); }
});

test("duplicate attribution calls share one stamp lifecycle", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    await Promise.all([f.runtime.attributeTarget(candidate, f.port), f.runtime.attributeTarget(candidate, f.port)]);
    expect(f.observed).toHaveLength(1);
    expect(f.routed).toHaveLength(1);
  } finally { f.runtime.close(); }
});

test("route verification failure reparks the exact matched window and surfaces failure", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.port.routeAndVerify = async () => { throw new Error("move not verified"); };
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("move not verified");
    expect(f.parked).toEqual(["41"]);
    expect(f.ownership.isUnowned("41")).toBe(true);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { f.runtime.close(); }
});

test("scratchpad failure is surfaced and is never recorded as successful terminal parking", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.port.routeAndVerify = async () => { throw new Error("move not verified"); };
    f.port.park = async () => { throw new Error("scratchpad failed"); };
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("scratchpad failed");
    expect(f.ownership.isUnowned("41")).toBe(false);
    expect(f.ownership.windowsFor("A")).toEqual([]);
  } finally { f.runtime.close(); }
});

test("caller cancellation remains cancellation when reparking cleanup also fails", async () => {
  const f = fixture();
  const caller = new AbortController();
  const reason = new Error("caller cancelled during movement");
  const cleanupLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const candidate = pending(f);
    f.port.routeAndVerify = async () => { caller.abort(reason); };
    f.port.park = async () => { throw new Error("scratchpad unavailable during cleanup"); };
    const failure = await f.runtime.attributeTarget(candidate, f.port, caller.signal).catch(error => error);
    expect(failure).toBe(reason);
    expect(cleanupLog).toHaveBeenCalledWith("Browser attribution cancellation could not re-park its window", expect.objectContaining({ message: "scratchpad unavailable during cleanup" }));
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { cleanupLog.mockRestore(); f.runtime.close(); }
});

test("Screen release during observation restores the title and cannot re-register registry-only work", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const entered = Promise.withResolvers<void>();
    f.port.observeTitle = async (_nonce, signal) => {
      entered.resolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const result = f.runtime.attributeTarget(candidate, f.port);
    const failure = result.catch(error => error);
    await entered.promise;
    f.runtime.dropScreen("A");
    expect((await failure).message).toContain("Screen closed");
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.routed).toEqual([]);
  } finally { f.runtime.close(); }
});

test("target destruction cancels stamps and duplicate late info events cannot resurrect work", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.port.observeTitle = async (_nonce, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const result = f.runtime.attributeTarget(candidate, f.port);
    const failure = result.catch(error => error);
    await until(() => f.log.some(command => command.method === "Runtime.evaluate" && String(command.params.expression).startsWith("document.title =")));
    f.event("Target.targetDestroyed", { targetId: "a" });
    const error = await failure;
    expect(error).toMatchObject({ name: "BrowserWindowAttributionError", retryable: true, targetId: "a" });
    expect(error.message).toContain("retry liveness preflight confirms the target is gone");
    expect(f.log.filter(command => command.method === "Target.attachToTarget")).toHaveLength(1);
    expect(f.ownership.hasPendingTarget(candidate)).toBe(false);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    f.ownership.register("B", "opener", 102, "b");
    f.event("Target.targetInfoChanged", { targetInfo: { targetId: "a", type: "page", openerId: "b" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.routed).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { f.runtime.close(); }
});

test("navigation during a stamp retries with a fresh isolated world and preserves the new document title", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const observe = f.port.observeTitle;
    let attempts = 0;
    f.port.observeTitle = async (nonce, signal) => {
      if (++attempts === 1) {
        f.pages.get("a")!.title = "New document title";
        const sessionId = [...f.sessions.keys()][0]!;
        f.event("Page.frameNavigated", { frame: { id: "new-main" } }, sessionId);
        signal.throwIfAborted();
      }
      return observe(nonce, signal);
    };
    f.port.routeAndVerify = async () => { expect(f.pages.get("a")!.title).toBe("New document title"); };
    await f.runtime.attributeTarget(candidate, f.port);
    expect(attempts).toBe(2);
    expect(f.pages.get("a")!.title).toBe("New document title");
    expect(f.log.filter(command => command.method === "Page.createIsolatedWorld")).toHaveLength(2);
  } finally { f.runtime.close(); }
});

test("restoration errors fail closed before routing", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.intercept(command => {
      if (command.method !== "Runtime.evaluate" || !String(command.params.expression).startsWith("if (document.title")) return false;
      f.reply(command, { exceptionDetails: { text: "restore refused" } });
      return true;
    });
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("restore refused");
    expect(f.routed).toEqual([]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
  } finally { f.runtime.close(); }
});

test("ordinary tabs in an owned browser window do not start stamping", async () => {
  const f = fixture();
  try {
    f.ownership.register("A", "owned", 101, "opener");
    const candidate = f.ownership.recordPendingTarget("A", "a");
    const result = await f.runtime.attributeTarget(candidate, f.port);
    expect(result).toBeUndefined();
    expect(f.observed).toEqual([]);
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.log.some(command => command.method === "Target.attachToTarget")).toBe(false);
  } finally { f.runtime.close(); }
});

test("repeated opener events record both simultaneous owners without window counts", async () => {
  const f = fixture();
  try {
    f.ownership.register("A", "owned-a", 101, "a");
    f.ownership.register("B", "owned-b", 102, "b");
    for (const [targetId, openerId] of [["popup-a", "a"], ["popup-b", "b"]]) {
      f.event("Target.targetCreated", { targetInfo: { targetId, openerId, type: "page" } });
      f.event("Target.targetInfoChanged", { targetInfo: { targetId, openerId, type: "page" } });
    }
    await until(() => f.ownership.pendingTargets().length === 2);
    expect(f.ownership.pendingTargets().map(({ surfaceId, targetId }) => ({ surfaceId, targetId }))).toEqual([
      { surfaceId: "A", targetId: "popup-a" }, { surfaceId: "B", targetId: "popup-b" },
    ]);
    expect(f.log.filter(command => command.method === "Browser.getWindowForTarget")).toHaveLength(2);
    expect(f.log.some(command => command.method === "Target.getTargets")).toBe(false);
  } finally { f.runtime.close(); }
});

test("opener lookup cannot record a late candidate after Screen release", async () => {
  const f = fixture();
  try {
    f.ownership.register("A", "owned-a", 101, "a");
    let lookup: Command | undefined;
    f.intercept(command => {
      if (command.method !== "Browser.getWindowForTarget") return false;
      lookup = command; return true;
    });
    f.event("Target.targetCreated", { targetInfo: { targetId: "popup-a", openerId: "a", type: "page" } });
    await until(() => lookup !== undefined);
    f.runtime.dropScreen("A");
    f.reply(lookup!, { windowId: 101 });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.ownership.pendingTargets()).toEqual([]);
  } finally { f.runtime.close(); }
});

test("late attachment after caller cancellation is detached without stamping", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    let attachment: Command | undefined;
    f.intercept(command => {
      if (command.method !== "Target.attachToTarget") return false;
      attachment = command; return true;
    });
    const controller = new AbortController();
    const result = f.runtime.attributeTarget(candidate, f.port, controller.signal).catch(error => error);
    await until(() => attachment !== undefined);
    controller.abort(new Error("caller stopped"));
    expect((await result).message).toBe("caller stopped");
    f.reply(attachment!, { sessionId: "late-session" });
    await until(() => f.log.some(command => command.method === "Target.detachFromTarget" && command.params.sessionId === "late-session"));
    expect(f.log.some(command => command.method === "Runtime.evaluate")).toBe(false);
  } finally { f.runtime.close(); }
});

test("a lost stamp-write reply still restores the original title before retry", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    let writes = 0;
    f.intercept(command => {
      if (command.method !== "Runtime.evaluate" || !String(command.params.expression).startsWith("document.title =")) return false;
      if (++writes !== 1) return false;
      f.pages.get("a")!.title = runInNewContext(String(command.params.expression), { document: {} });
      return true;
    });
    await f.runtime.attributeTarget(candidate, f.port);
    expect(writes).toBe(2);
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.routed).toEqual(["A:41"]);
  } finally { f.runtime.close(); }
});

test("Computer reset during verified movement reparks and prevents stale completion", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.port.routeAndVerify = async () => { f.ownership.reset(); };
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("Computer restarted");
    expect(f.parked).toEqual(["41"]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.ownership.isUnowned("41")).toBe(false);
  } finally { f.runtime.close(); }
});

test("two candidates cannot concurrently route the same parked native window", async () => {
  const f = fixture();
  try {
    const a = pending(f);
    const b = pending(f, "B", "b");
    f.pages.get("b")!.swayWindowId = "41";
    f.pages.get("b")!.windowId = 101;
    f.port.observeTitle = async nonce => ({ swayWindowId: "41", title: nonce });
    const moving = Promise.withResolvers<void>();
    const finishMove = Promise.withResolvers<void>();
    f.port.routeAndVerify = async surfaceId => {
      f.routed.push(surfaceId);
      moving.resolve();
      await finishMove.promise;
    };
    const first = f.runtime.attributeTarget(a, f.port);
    await moving.promise;
    const second = f.runtime.attributeTarget(b, f.port).catch(error => error);
    const rejected = await second;
    finishMove.resolve();
    await first;
    expect(rejected).toBeInstanceOf(Error);
    expect(f.routed).toEqual(["A"]);
    expect(f.parked).toEqual([]);
    expect(f.ownership.ownerOfSwayWindow("41")).toBe("A");
  } finally { f.runtime.close(); }
});

test("a target moving to another Chromium window during observation is retried before any registration", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const observe = f.port.observeTitle;
    let attempts = 0;
    f.port.observeTitle = async (nonce, signal) => {
      const result = await observe(nonce, signal);
      if (++attempts === 1) f.pages.get("a")!.windowId = 103;
      return result;
    };
    await f.runtime.attributeTarget(candidate, f.port);
    expect(attempts).toBe(2);
    expect(f.ownership.ownerOfBrowserWindow(101)).toBeUndefined();
    expect(f.ownership.ownerOfBrowserWindow(103)?.swayWindowId).toBe("41");
    expect(f.routed).toEqual(["A:41"]);
  } finally { f.runtime.close(); }
});

test("a transient missing target window gets one retry rather than an unstamped binding", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    let lookups = 0;
    f.intercept(command => {
      if (command.method !== "Browser.getWindowForTarget") return false;
      if (++lookups !== 1) return false;
      f.reply(command, {}); return true;
    });
    await f.runtime.attributeTarget(candidate, f.port);
    expect(lookups).toBe(3);
    expect(f.observed).toHaveLength(1);
    expect(f.ownership.ownerOfSwayWindow("41")).toBe("A");
  } finally { f.runtime.close(); }
});

test("CDP stamp exceptions retry once and never route or register", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    let writes = 0;
    f.intercept(command => {
      if (command.method !== "Runtime.evaluate" || !String(command.params.expression).startsWith("document.title =")) return false;
      writes++;
      f.reply(command, { exceptionDetails: { text: "stamp refused" } }); return true;
    });
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("stamp refused");
    expect(writes).toBe(2);
    expect(f.routed).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
    expect(f.ownership.windowsFor("A")).toEqual([]);
  } finally { f.runtime.close(); }
});

test("a page resetting its nonce retries and retains the page's new real title", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    const observe = f.port.observeTitle;
    let attempts = 0;
    f.port.observeTitle = async (nonce, signal) => {
      if (++attempts === 1) {
        f.pages.get("a")!.title = "Updated by page";
        throw new Error("page reset title");
      }
      return observe(nonce, signal);
    };
    f.port.routeAndVerify = async () => { expect(f.pages.get("a")!.title).toBe("Updated by page"); };
    await f.runtime.attributeTarget(candidate, f.port);
    expect(attempts).toBe(2);
    expect(f.pages.get("a")!.title).toBe("Updated by page");
  } finally { f.runtime.close(); }
});

test("a pipe closing during observation fails without routing or registering", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    f.port.observeTitle = async () => {
      f.runtime.close();
      throw new Error("pipe lost");
    };
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toThrow("runtime closed");
    expect(f.routed).toEqual([]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.ownership.pendingTargets()).toEqual([]);
  } finally { f.runtime.close(); }
});

test("an exhausted stamp cannot restart through duplicate target metadata", async () => {
  const f = fixture();
  try {
    f.ownership.register("B", "opener", 102, "b");
    f.ownership.markParked("41");
    f.refused.add("a");
    f.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", openerId: "b" } });
    await until(() => f.ownership.pendingTargets().length === 1);
    const candidate = f.ownership.pendingTargets()[0]!;
    f.port.observeTitle = async (_nonce, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await expect(f.runtime.attributeTarget(candidate, f.port)).rejects.toMatchObject({ retryable: true });
    const commands = f.log.length;
    f.event("Target.targetInfoChanged", { targetInfo: { targetId: "a", type: "page", openerId: "b" } });
    f.event("Target.targetCreated", { targetInfo: { targetId: "a", type: "page", openerId: "b" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.ownership.pendingTargets()).toEqual([]);
    expect(f.log).toHaveLength(commands);
    expect(f.ownership.windowsFor("B").map(window => window.swayWindowId)).toEqual(["opener"]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { f.runtime.close(); }
});

test("target destruction during attachment exhausts its retry preflight and detaches a late session", async () => {
  const f = fixture();
  try {
    const candidate = pending(f);
    let attachment: Command | undefined;
    f.intercept(command => {
      if (command.method !== "Target.attachToTarget") return false;
      attachment = command;
      return true;
    });
    const result = f.runtime.attributeTarget(candidate, f.port).catch(error => error);
    await until(() => attachment !== undefined);
    f.event("Target.targetDestroyed", { targetId: "a" });
    const error = await result;
    expect(error).toMatchObject({ name: "BrowserWindowAttributionError", retryable: true });
    expect(error.message).toContain("retry liveness preflight confirms the target is gone");
    expect(f.ownership.hasPendingTarget(candidate)).toBe(false);
    f.reply(attachment!, { sessionId: "late-destroyed-session" });
    await until(() => f.log.some(command => command.method === "Target.detachFromTarget" && command.params.sessionId === "late-destroyed-session"));
    expect(f.log.filter(command => command.method === "Target.attachToTarget")).toHaveLength(1);
    expect(f.log.some(command => command.method === "Runtime.evaluate")).toBe(false);
    expect(f.routed).toEqual([]);
    expect(f.ownership.windowsFor("A")).toEqual([]);
    expect(f.pages.get("a")!.title).toBe("Same real title");
  } finally { f.runtime.close(); }
});
