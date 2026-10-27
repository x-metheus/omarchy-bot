import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";
import type { BrowserAction, ComputerAction } from "@omarchy-bot/domain";
import { setTimeout as delay } from "node:timers/promises";
import { CdpPipe } from "./cdpPipe.ts";

export interface BrowserScreenPort {
  windows(): Promise<ComputerWindowListItem[]>;
  focusWindow(window: ComputerWindowListItem): Promise<void>;
  input(action: ComputerAction): Promise<void>;
}
export interface BrowserResult { text: string; truncated?: boolean }
interface TargetInfo { targetId: string; type: string; title: string; url: string }
interface TargetWindow { windowId: number; bounds: { left?: number; top?: number; width?: number; height?: number } }
interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}
interface Tab {
  targetId: string;
  sessionId: string;
  frameId?: string;
  contextId?: number;
  navigation: number;
}
interface Screen {
  controller: AbortController;
  windows: Map<number, string>;
  active?: string;
  refs: Map<string, { backendNodeId: number; targetId: string }>;
  tabs: Map<string, Tab>;
}
interface Scope { screen: Screen; window: ComputerWindowListItem; targets: TargetInfo[]; targetWindows: Map<string, ComputerWindowListItem> }
const SNAPSHOT_BYTES = 16 * 1024;
const TEXT_BYTES = 8 * 1024;

/** One private browser pipe, with target and element authority scoped to routed Screen windows. */
export class BrowserRuntime {
  #screens = new Map<string, Screen>();
  #owners = new Map<number, { surfaceId: string; swayWindowId: string }>();
  #refSequence = 0;
  #unsubscribe: () => void;
  #browserPid?: number;

  constructor(private readonly cdp: CdpPipe) {
    this.#unsubscribe = cdp.onEvent((method, params, sessionId) => {
      for (const screen of this.#screens.values()) {
        for (const tab of screen.tabs.values()) {
          if (method === "Target.targetDestroyed" && params.targetId === tab.targetId
            || method === "Target.detachedFromTarget" && params.sessionId === tab.sessionId) {
            screen.tabs.delete(tab.targetId);
            screen.refs.clear();
            if (screen.active === tab.targetId) delete screen.active;
          } else if (sessionId === tab.sessionId) {
            const frame = params.frame as { id?: string; parentId?: string } | undefined;
            if (method === "Page.frameNavigated" && frame?.parentId === undefined
              || method === "Page.navigatedWithinDocument" && params.frameId === tab.frameId
              || method === "DOM.documentUpdated") {
              delete tab.contextId;
              if (method === "Page.frameNavigated") {
                if (frame?.id) tab.frameId = frame.id;
                else delete tab.frameId;
              }
              tab.navigation++;
              screen.refs.clear();
            }
          }
        }
      }
    });
  }

  get alive(): boolean { return this.cdp.alive; }

  async pageTargets(signal?: AbortSignal): Promise<TargetInfo[]> {
    const { targetInfos } = await this.cdp.request<{ targetInfos: TargetInfo[] }>("Target.getTargets", {}, undefined, signal ? { signal } : {});
    return targetInfos.filter((target) => target.type === "page");
  }

  async processId(signal?: AbortSignal): Promise<number> {
    if (this.#browserPid !== undefined) return this.#browserPid;
    const { processInfo } = await this.cdp.request<{ processInfo: { type: string; id: number }[] }>("SystemInfo.getProcessInfo", {}, undefined, signal ? { signal } : {});
    const browser = processInfo.filter(process => process.type === "browser");
    if (browser.length !== 1 || !Number.isSafeInteger(browser[0]!.id) || browser[0]!.id <= 0) throw new Error("Cannot determine owned browser process identity");
    return this.#browserPid = browser[0]!.id;
  }

  /** Launch integration may bind an exact routed window when page titles are ambiguous. */
  async registerTarget(surfaceId: string, targetId: string, swayWindowId: string, signal?: AbortSignal): Promise<void> {
    const { windowId } = await this.cdp.request<TargetWindow>("Browser.getWindowForTarget", { targetId }, undefined, signal ? { signal } : {});
    signal?.throwIfAborted();
    this.#bind(surfaceId, this.#screen(surfaceId), windowId, swayWindowId);
    const screen = this.#screen(surfaceId);
    screen.active = targetId;
    screen.refs.clear();
  }

  async perform(surfaceId: string, action: BrowserAction, port: BrowserScreenPort, signal?: AbortSignal): Promise<BrowserResult> {
    const screen = this.#screen(surfaceId);
    const timeoutMs = action.name === "wait_for" ? waitTimeout(action.args.timeoutMs) : 30_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([screen.controller.signal, deadline, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      const scope = await this.#scope(surfaceId, port, combined);
      if (action.name === "tabs") return await this.#tabs(surfaceId, scope, action.args, port, combined);
      const tab = await this.#tab(scope, combined);
      switch (action.name) {
        case "snapshot": return await this.#snapshot(screen, tab, combined);
        case "read_text": return await this.#readText(screen, tab, action.args.ref, combined);
        case "click":
        case "type":
        case "select": {
          const backendNodeId = this.#ref(screen, tab, action.args.ref);
          if (action.name === "type" && typeof action.args.text !== "string") throw new Error("type requires args.text");
          let optionIndex: number | undefined;
          if (action.name === "select") {
            const value = requiredString(action.args.value, "select requires args.value");
            const options = await this.#elementValue<{ value: string; label: string; disabled: boolean }[]>(tab, backendNodeId,
              "function() { if (this.tagName !== 'SELECT' || this.multiple) throw new Error('select requires a single native select'); return Array.from(this.options, o => ({value:o.value,label:o.label,disabled:o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled)})); }", combined);
            const enabled = options.filter((option) => !option.disabled);
            optionIndex = enabled.findIndex((option) => option.value === value || option.label === value);
            if (optionIndex < 0) throw new Error(`No enabled select option matches ${JSON.stringify(value)}`);
          }
          await this.#click(surfaceId, screen, tab, backendNodeId, port, combined);
          combined.throwIfAborted();
          if (action.name === "type") await port.input({ name: "type", args: { text: action.args.text } });
          if (optionIndex !== undefined) {
            await port.input({ name: "key", args: { key: "Home" } });
            for (let i = 0; i < optionIndex; i++) { combined.throwIfAborted(); await port.input({ name: "key", args: { key: "Down" } }); }
            combined.throwIfAborted();
            await port.input({ name: "key", args: { key: "Enter" } });
          }
          return { text: `${action.name} completed` };
        }
        case "navigate": {
          const url = navigationUrl(action.args.url);
          this.#invalidate(screen, tab);
          const result = await this.cdp.request<{ errorText?: string }>("Page.navigate", { url }, tab.sessionId, { signal: combined });
          if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
          return { text: `Navigated to ${url}` };
        }
        case "back": {
          const history = await this.cdp.request<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, tab.sessionId, { signal: combined });
          const entry = history.entries[history.currentIndex - 1];
          if (!entry) throw new Error("No previous browser history entry");
          this.#invalidate(screen, tab);
          await this.cdp.request("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId, { signal: combined });
          return { text: "Navigated back" };
        }
        case "wait_for": return await this.#wait(surfaceId, scope, tab, action.args, port, combined);
        case "request_takeover": throw new Error("request_takeover must be handled by the Computer Broker");
        default: throw new Error(`Unknown browser action: ${action.name}`);
      }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted && !screen.controller.signal.aborted) throw new Error(`Browser ${action.name} timed out after ${timeoutMs}ms`);
      if (error instanceof Error && /(?:no node with given id|could not find node|node with given id does not belong|could not find object with given id|cannot find context with specified id|execution context was destroyed)/i.test(error.message)) {
        screen.refs.clear();
        throw new Error("Browser element or document no longer exists; take a new snapshot before acting");
      }
      throw error;
    }
  }

  dropScreen(surfaceId: string): void {
    const screen = this.#screens.get(surfaceId);
    if (!screen) return;
    screen.controller.abort(new Error("Browser Screen closed"));
    for (const tab of screen.tabs.values()) void this.cdp.request("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
    for (const windowId of screen.windows.keys()) this.#owners.delete(windowId);
    this.#screens.delete(surfaceId);
  }

  close(): void {
    for (const surfaceId of this.#screens.keys()) this.dropScreen(surfaceId);
    this.#unsubscribe();
    this.cdp.close();
  }

  #screen(surfaceId: string): Screen {
    let screen = this.#screens.get(surfaceId);
    if (!screen) {
      screen = { controller: new AbortController(), windows: new Map(), refs: new Map(), tabs: new Map() };
      this.#screens.set(surfaceId, screen);
    }
    return screen;
  }

  #bind(surfaceId: string, screen: Screen, windowId: number, swayWindowId: string): void {
    if (!Number.isInteger(windowId)) throw new Error("Browser returned an invalid window identity");
    const owner = this.#owners.get(windowId);
    if (owner && (owner.surfaceId !== surfaceId || owner.swayWindowId !== swayWindowId)) throw new Error("Browser window belongs to another Screen");
    this.#owners.set(windowId, { surfaceId, swayWindowId });
    screen.windows.set(windowId, swayWindowId);
  }

  async #scope(surfaceId: string, port: BrowserScreenPort, signal: AbortSignal): Promise<Scope> {
    const screen = this.#screen(surfaceId);
    const windows = await port.windows();
    const browserPid = await this.processId(signal);
    signal.throwIfAborted();
    const { targetInfos } = await this.cdp.request<{ targetInfos: TargetInfo[] }>("Target.getTargets", {}, undefined, { signal });
    const pages = targetInfos.filter((target) => target.type === "page");
    const locations = new Map<string, TargetWindow>();
    for (const target of pages) {
      try { locations.set(target.targetId, await this.cdp.request<TargetWindow>("Browser.getWindowForTarget", { targetId: target.targetId }, undefined, { signal })); }
      catch (error) {
        signal.throwIfAborted();
        if (!this.alive) throw error;
        const live = await this.pageTargets(signal);
        if (live.some(current => current.targetId === target.targetId)) throw new Error("Cannot determine browser window ownership; take a new snapshot");
      }
    }
    let lostWindow = false;
    for (const [windowId, swayWindowId] of screen.windows) {
      if (!windows.some((window) => window.id === swayWindowId && window.pid === browserPid)) {
        screen.windows.delete(windowId);
        this.#owners.delete(windowId);
        screen.refs.clear();
        lostWindow = true;
      }
    }
    const candidateMatches = new Map<string, Set<number>>();
    for (const candidate of windows) {
      if (candidate.pid !== browserPid || !candidate.bounds || [...screen.windows.values()].includes(candidate.id)) continue;
      const matches = new Set<number>();
      for (const target of pages) {
        const location = locations.get(target.targetId);
        if (!location || this.#owners.has(location.windowId) || !titleMatches(candidate.title, target.title, target.url)) continue;
        // Chromium includes a synthetic outer frame; Sway reports content below its title bar.
        if (Math.abs((location.bounds.width ?? 0) - candidate.bounds.width) > 40 || Math.abs((location.bounds.height ?? 0) - candidate.bounds.height) > 40) continue;
        matches.add(location.windowId);
      }
      candidateMatches.set(candidate.id, matches);
    }
    for (const matches of candidateMatches.values()) {
      const windowId = matches.values().next().value;
      if (matches.size > 1 || windowId !== undefined && [...candidateMatches.values()].filter((other) => other.has(windowId)).length > 1) throw new Error("Ambiguous browser window ownership; give the Screen browser a unique page title");
    }
    for (const [swayWindowId, matches] of candidateMatches) {
      const windowId = matches.values().next().value;
      if (windowId !== undefined) this.#bind(surfaceId, screen, windowId, swayWindowId);
    }
    const targetWindows = new Map<string, ComputerWindowListItem>();
    for (const target of pages) {
      const location = locations.get(target.targetId);
      const swayWindowId = location ? screen.windows.get(location.windowId) : undefined;
      const window = windows.find((candidate) => candidate.id === swayWindowId);
      if (window) targetWindows.set(target.targetId, window);
    }
    const targets = pages.filter((target) => targetWindows.has(target.targetId));
    for (const tab of screen.tabs.values()) {
      if (!targets.some((target) => target.targetId === tab.targetId)) {
        screen.tabs.delete(tab.targetId);
        screen.refs.clear();
        void this.cdp.request("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
      }
    }
    if (!targets.length) throw new Error(lostWindow ? "Browser window is no longer routed to this Screen; take a new snapshot after opening a browser" : "No browser window belongs to this Screen; open a browser on this Screen first");
    const focused = [...new Set(targetWindows.values())].filter(window => window.focused);
    if (focused.length > 1) throw new Error("Cannot determine the selected browser window; focus one browser window and take a new snapshot");
    const window = focused[0] ?? targetWindows.get(screen.active ?? "") ?? targetWindows.get(targets[0]!.targetId)!;
    const visible: TargetInfo[] = [];
    for (const target of targets.filter(target => targetWindows.get(target.targetId) === window)) {
      const tab = await this.#tab({ screen, window, targets, targetWindows }, signal, target.targetId);
      const contextId = await this.#context(tab, signal);
      const result = await this.cdp.request<{ result: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: "document.visibilityState === 'visible'", contextId, returnByValue: true }, tab.sessionId, { signal });
      if (result.exceptionDetails) throw new Error("Cannot determine the selected browser tab; take a new snapshot");
      if (result.result.value === true) visible.push(target);
    }
    if (visible.length !== 1) {
      screen.refs.clear();
      delete screen.active;
      throw new Error("Cannot determine the selected browser tab; select one tab and take a new snapshot");
    }
    const active = visible[0]!.targetId;
    if (screen.active !== active) { screen.active = active; screen.refs.clear(); }
    return { screen, window: targetWindows.get(active!)!, targets, targetWindows };
  }

  async #tab(scope: Scope, signal: AbortSignal, targetId = scope.screen.active!): Promise<Tab> {
    let tab = scope.screen.tabs.get(targetId);
    if (tab) return tab;
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const attachment = this.cdp.request<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    void attachment.then(({ sessionId }) => {
      if (signal.aborted) void this.cdp.request("Target.detachFromTarget", { sessionId }).catch(() => {});
    }, () => {});
    let sessionId: string;
    try { ({ sessionId } = await Promise.race([attachment, aborted.promise])); }
    finally { signal.removeEventListener("abort", onAbort); }
    signal.throwIfAborted();
    tab = { targetId, sessionId, navigation: 0 };
    scope.screen.tabs.set(targetId, tab);
    try {
      await this.cdp.request("Page.enable", {}, sessionId, { signal });
      const { frameTree } = await this.cdp.request<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId, { signal });
      tab.frameId = frameTree.frame.id;
    }
    catch (error) {
      scope.screen.tabs.delete(targetId);
      void this.cdp.request("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw error;
    }
    return tab;
  }

  #invalidate(screen: Screen, tab: Tab): void {
    screen.refs.clear();
    delete tab.contextId;
    delete tab.frameId;
    tab.navigation++;
  }

  #ref(screen: Screen, tab: Tab, value: unknown): number {
    const ref = typeof value === "string" ? screen.refs.get(value) : undefined;
    if (!ref || ref.targetId !== tab.targetId) throw new Error(`Stale or missing Element Ref ${String(value)}; take a new snapshot before acting`);
    return ref.backendNodeId;
  }

  async #snapshot(screen: Screen, tab: Tab, signal: AbortSignal): Promise<BrowserResult> {
    screen.refs.clear();
    const navigation = tab.navigation;
    const { nodes } = await this.cdp.request<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId, { signal });
    if (navigation !== tab.navigation) throw new Error("Page navigated during snapshot; take a new snapshot");
    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const parents = new Map<string, string>();
    for (const node of nodes) {
      if (node.parentId) parents.set(node.nodeId, node.parentId);
      for (const childId of node.childIds ?? []) parents.set(childId, node.nodeId);
    }
    for (const node of nodes) {
      if (node.ignored) continue;
      const ref = node.backendDOMNodeId ? `e${++this.#refSequence}` : undefined;
      const states = (node.properties ?? []).filter((property) => ["disabled", "checked", "selected", "expanded", "required", "readonly", "pressed", "focused", "level"].includes(property.name)).map((property) => `${property.name}=${JSON.stringify(property.value.value)}`);
      let depth = 0;
      let parent = parents.get(node.nodeId);
      const seen = new Set([node.nodeId]);
      while (parent && !seen.has(parent) && depth < 30) {
        seen.add(parent);
        if (!byId.get(parent)?.ignored) depth++;
        parent = parents.get(parent);
      }
      const line = `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${String(node.role?.value ?? "node")} ${JSON.stringify(node.name?.value ?? "")}${node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : ""}${states.length ? ` ${states.join(" ")}` : ""}`;
      if (lines.length >= 300 || bytes + Buffer.byteLength(line) + 1 > SNAPSHOT_BYTES) { truncated = true; break; }
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
      if (ref) screen.refs.set(ref, { backendNodeId: node.backendDOMNodeId!, targetId: tab.targetId });
    }
    return { text: lines.join("\n"), ...(truncated ? { truncated: true } : {}) };
  }

  async #context(tab: Tab, signal: AbortSignal): Promise<number> {
    if (tab.contextId !== undefined) return tab.contextId;
    const { frameTree } = await this.cdp.request<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab.sessionId, { signal });
    const { executionContextId } = await this.cdp.request<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "omarchy-bot-browser" }, tab.sessionId, { signal });
    tab.frameId = frameTree.frame.id;
    tab.contextId = executionContextId;
    return executionContextId;
  }

  async #elementValue<T>(tab: Tab, backendNodeId: number, functionDeclaration: string, signal: AbortSignal): Promise<T> {
    const executionContextId = await this.#context(tab, signal);
    const { object } = await this.cdp.request<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId, executionContextId }, tab.sessionId, { signal });
    if (!object.objectId) throw new Error("Element no longer exists; take a new snapshot");
    try {
      const response = await this.cdp.request<{ result: { value: T }; exceptionDetails?: { text?: string } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, returnByValue: true }, tab.sessionId, { signal });
      if (response.exceptionDetails) throw new Error(`Browser element read failed: ${response.exceptionDetails.text ?? "element unavailable"}`);
      return response.result.value;
    } finally { void this.cdp.request("Runtime.releaseObject", { objectId: object.objectId }, tab.sessionId).catch(() => {}); }
  }

  async #readText(screen: Screen, tab: Tab, ref: unknown, signal: AbortSignal): Promise<BrowserResult> {
    let text: string;
    if (ref !== undefined) {
      text = await this.#elementValue<string>(tab, this.#ref(screen, tab, ref), "function() { return (this.innerText ?? this.textContent ?? '').slice(0, 32769); }", signal);
    } else {
      const contextId = await this.#context(tab, signal);
      const result = await this.cdp.request<{ result: { value?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: "(document.body?.innerText ?? document.documentElement?.textContent ?? '').slice(0, 32769)", contextId, returnByValue: true }, tab.sessionId, { signal });
      if (result.exceptionDetails) throw new Error("Browser page text is unavailable");
      text = result.result.value ?? "";
    }
    return boundedText(text, TEXT_BYTES);
  }

  async #click(surfaceId: string, screen: Screen, tab: Tab, backendNodeId: number, port: BrowserScreenPort, signal: AbortSignal): Promise<void> {
    const scope = await this.#scope(surfaceId, port, signal);
    if (scope.screen !== screen || screen.active !== tab.targetId) throw new Error("Browser tab changed; take a new snapshot");
    await port.focusWindow(scope.window);
    signal.throwIfAborted();
    await this.cdp.request("Target.activateTarget", { targetId: tab.targetId }, undefined, { signal });
    await this.cdp.request("DOM.scrollIntoViewIfNeeded", { backendNodeId }, tab.sessionId, { signal });
    const contextId = await this.#context(tab, signal);
    await this.cdp.request("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => resolve(true)))", contextId, awaitPromise: true, returnByValue: true }, tab.sessionId, { signal });
    const { model } = await this.cdp.request<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, tab.sessionId, { signal });
    const { cssLayoutViewport } = await this.cdp.request<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, tab.sessionId, { signal });
    const viewport = await this.cdp.request<{ result: { value: { width: number; height: number } }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: "({width: innerWidth, height: innerHeight})", contextId, returnByValue: true }, tab.sessionId, { signal });
    if (viewport.exceptionDetails || !Number.isFinite(viewport.result.value?.width) || !Number.isFinite(viewport.result.value?.height) || viewport.result.value.width <= 0 || viewport.result.value.height <= 0) throw new Error("Browser viewport geometry is unavailable");
    const bounds = scope.window.bounds;
    const quad = model.content;
    if (!bounds || quad.length !== 8 || !quad.every(Number.isFinite) || cssLayoutViewport.clientWidth <= 0 || cssLayoutViewport.clientHeight <= 0) throw new Error("Browser element has no usable Screen coordinates");
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    if (x < 0 || y < 0 || x >= cssLayoutViewport.clientWidth || y >= cssLayoutViewport.clientHeight) throw new Error("Browser element is outside the visible page; take a new snapshot");
    // innerWidth/Height include scrollbar gutters; layout client sizes do not.
    const scale = bounds.width / viewport.result.value.width;
    const chrome = bounds.height - viewport.result.value.height * scale;
    if (!Number.isFinite(scale) || scale <= 0 || chrome < -2 || chrome >= bounds.height) throw new Error("Browser viewport does not match the routed Screen window");
    const current = (await port.windows()).find((window) => window.id === scope.window.id);
    signal.throwIfAborted();
    if (!current?.bounds || JSON.stringify(current.bounds) !== JSON.stringify(bounds)) throw new Error("Browser window moved; take a new snapshot");
    await port.input({ name: "click", args: { x: Math.round(bounds.x + x * scale), y: Math.round(bounds.y + Math.max(0, chrome) + y * scale) } });
  }

  async #tabs(surfaceId: string, scope: Scope, args: Record<string, unknown>, port: BrowserScreenPort, signal: AbortSignal): Promise<BrowserResult> {
    const operation = args.operation ?? "list";
    if (operation === "list") return boundedText(scope.targets.map((target) => `${target.targetId === scope.screen.active ? "* " : "  "}${target.targetId} ${JSON.stringify(target.title)} ${target.url}`).join("\n"), SNAPSHOT_BYTES);
    if (operation === "open") {
      const url = navigationUrl(args.url ?? "about:blank");
      const before = new Set(scope.targets.map((target) => target.targetId));
      await port.focusWindow(scope.window);
      signal.throwIfAborted();
      await this.cdp.request("Target.activateTarget", { targetId: scope.screen.active }, undefined, { signal });
      await port.input({ name: "key", args: { key: "Ctrl+t" } });
      let created: TargetInfo | undefined;
      while (!created) {
        signal.throwIfAborted();
        scope = await this.#scope(surfaceId, port, signal);
        created = scope.targets.find((target) => !before.has(target.targetId));
        if (!created) await delay(50, undefined, { signal });
      }
      scope.screen.active = created.targetId;
      scope.screen.refs.clear();
      const tab = await this.#tab(scope, signal);
      const result = await this.cdp.request<{ errorText?: string }>("Page.navigate", { url }, tab.sessionId, { signal });
      if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`);
      return { text: `Opened tab ${created.targetId} ${url}` };
    }
    if (operation !== "switch" && operation !== "close") throw new Error("tabs operation must be list, open, switch, or close");
    const targetId = requiredString(args.tabId, "tabs requires args.tabId");
    if (!scope.targets.some((target) => target.targetId === targetId)) throw new Error("Browser tab does not belong to this Screen");
    scope.screen.refs.clear();
    if (operation === "switch") {
      await port.focusWindow(scope.targetWindows.get(targetId)!);
      signal.throwIfAborted();
      await this.cdp.request("Target.activateTarget", { targetId }, undefined, { signal });
      scope.screen.active = targetId;
      return { text: `Switched to tab ${targetId}` };
    }
    const tab = scope.screen.tabs.get(targetId);
    if (tab) {
      await this.cdp.request("Target.detachFromTarget", { sessionId: tab.sessionId }, undefined, { signal });
      scope.screen.tabs.delete(targetId);
    }
    await this.cdp.request("Target.closeTarget", { targetId }, undefined, { signal });
    if (scope.screen.active === targetId) delete scope.screen.active;
    return { text: `Closed tab ${targetId}` };
  }

  async #wait(surfaceId: string, scope: Scope, tab: Tab, args: Record<string, unknown>, port: BrowserScreenPort, signal: AbortSignal): Promise<BrowserResult> {
    const count = Number(args.text !== undefined) + Number(args.ref !== undefined) + Number(args.navigation !== undefined);
    if (count !== 1) throw new Error("wait_for requires exactly one of text, ref, or navigation");
    if (args.text !== undefined) requiredString(args.text, "wait_for text must be non-empty");
    if (args.navigation !== undefined && args.navigation !== true) throw new Error("wait_for navigation must be true");
    const ref = args.ref === undefined ? undefined : this.#ref(scope.screen, tab, args.ref);
    const initialNavigation = tab.navigation;
    const initialFrame = await this.cdp.request<{ frameTree: { frame: { loaderId?: string; url?: string } } }>("Page.getFrameTree", {}, tab.sessionId, { signal });
    const frameIdentity = JSON.stringify(initialFrame.frameTree.frame);
    for (;;) {
      signal.throwIfAborted();
      const current = await this.#scope(surfaceId, port, signal);
      if (current.screen.active !== tab.targetId) throw new Error("Browser tab changed; take a new snapshot");
      if (args.text !== undefined) {
        const contextId = await this.#context(tab, signal);
        const result = await this.cdp.request<{ result: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `(document.body?.innerText ?? document.documentElement?.textContent ?? '').includes(${JSON.stringify(args.text)})`, contextId, returnByValue: true }, tab.sessionId, { signal });
        if (result.exceptionDetails) throw new Error("Browser page text is unavailable");
        if (result.result.value === true) return { text: "Text found" };
      } else if (ref !== undefined) {
        this.#ref(scope.screen, tab, args.ref);
        try {
          const { model } = await this.cdp.request<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: ref }, tab.sessionId, { signal });
          if (model.content.length === 8 && model.content.every(Number.isFinite)) return { text: `Element Ref ${String(args.ref)} is present` };
        } catch (error) {
          if (!(error instanceof Error) || !/could not compute box model/i.test(error.message)) throw error;
        }
      } else {
        const frame = await this.cdp.request<{ frameTree: { frame: { loaderId?: string; url?: string } } }>("Page.getFrameTree", {}, tab.sessionId, { signal });
        if (tab.navigation !== initialNavigation || JSON.stringify(frame.frameTree.frame) !== frameIdentity) return { text: "Navigation observed" };
      }
      await delay(75, undefined, { signal });
    }
  }
}

function titleMatches(windowTitle: string, title: string, url: string): boolean {
  const names = title ? [title] : [url, url === "about:blank" ? "about:blank" : ""];
  return names.some((name) => name !== "" && (windowTitle === name || windowTitle.startsWith(`${name} - `) || windowTitle.startsWith(`${name} — `)));
}
function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value;
}
function navigationUrl(value: unknown): string {
  const raw = requiredString(value, "navigate requires args.url");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Browser URL must be absolute"); }
  if (!["http:", "https:", "file:", "about:"].includes(url.protocol)) throw new Error("Browser URL must use http, https, file, or about");
  return raw;
}
function waitTimeout(value: unknown): number {
  if (value === undefined) return 5_000;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 30_000) throw new Error("wait_for timeoutMs must be between 1 and 30000");
  return value;
}
function boundedText(text: string, limit: number): BrowserResult {
  if (Buffer.byteLength(text) <= limit) return { text };
  let end = limit;
  const bytes = Buffer.from(text);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
