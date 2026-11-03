import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";
import type { BrowserAction, ComputerAction } from "@omarchy-bot/domain";
import { setTimeout as delay } from "node:timers/promises";
import { CdpReplyTooLargeError, type CdpPipe } from "./cdpPipe.ts";
import { WindowOwnership, type OwnedWindow, type PendingWindowTarget } from "./windowOwnership.ts";
import { attributeBrowserTarget, type BrowserWindowAttributionPort } from "./browserWindowAttribution.ts";
export { BrowserWindowAttributionError, type BrowserWindowAttributionPort } from "./browserWindowAttribution.ts";

export interface BrowserScreenPort {
  windows(): Promise<ComputerWindowListItem[]>;
  focusWindow(window: ComputerWindowListItem): Promise<void>;
  input(action: ComputerAction): Promise<void>;
}
export interface BrowserResult { text: string; truncated?: boolean }
interface TargetInfo { targetId: string; type: string; title: string; url: string; openerId?: string }
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
  /** Snapshots in flight that need the Accessibility domain enabled on this session. */
  axUsers?: number;
}
interface Screen {
  controller: AbortController;
  active?: string;
  refs: Map<string, { backendNodeId: number; targetId: string }>;
  tabs: Map<string, Tab>;
}
interface Scope { screen: Screen; window: ComputerWindowListItem; targets: TargetInfo[]; targetWindows: Map<string, ComputerWindowListItem> }
/** Opener discovery is bounded independently of stamp/native-window observation. */
const POPUP_ATTRIBUTION_TIMEOUT_MS = 1_000;
const SNAPSHOT_BYTES = 16 * 1024;
const SNAPSHOT_LINES = 300;
/** Walk budget so long runs of ignored AX nodes cannot turn one snapshot into unbounded CDP traffic. */
const SNAPSHOT_VISIT_NODES = 4_000;
const SNAPSHOT_FETCHES = 1_000;
const TEXT_BYTES = 8 * 1024;

/** One private browser pipe, with target and element authority scoped to routed Screen windows. */
export class BrowserRuntime {
  #screens = new Map<string, Screen>();
  #refSequence = 0;
  #unsubscribe: () => void;
  #browserPid?: number;
  #discovery: Promise<void> | undefined;
  #lifetime = new AbortController();
  #openerLookups = new Map<string, AbortController>();
  #openerResults = new Map<string, Promise<void>>();
  #destroyedTargets = new Set<string>();
  #failedAttributions = new Set<string>();
  #attributions = new Map<PendingWindowTarget, { controller: AbortController; result: Promise<OwnedWindow | undefined> }>();

  /**
   * `ownership` is the Computer's one registry, shared with Sway routing; without
   * one this runtime keeps its own, which scopes ownership to this pipe.
   */
  constructor(
    private readonly cdp: CdpPipe,
    private readonly ownership = new WindowOwnership(),
    private readonly options: { stampTimeoutMs?: number; ownerForNewTarget?: (targetId: string) => string | undefined } = {},
  ) {
    if (!Number.isFinite(options.stampTimeoutMs ?? 2_000) || (options.stampTimeoutMs ?? 2_000) <= 0) {
      throw new Error("Browser title stamp deadline must be positive");
    }
    this.#unsubscribe = cdp.onEvent((method, params, sessionId) => {
      this.#onTargetEvent(method, params);
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
    void this.#ensureDiscovery().catch(() => {});
  }

  get alive(): boolean { return this.cdp.alive; }

  /**
   * Chromium reports a page's `openerId` only while target discovery is on, and
   * the pipe exists before any Screen asks for anything, so discovery is armed
   * here. It is idempotent and awaited by request paths, so a command that races
   * the listener still cannot lose an already delivered event.
   */
  async #ensureDiscovery(signal?: AbortSignal): Promise<void> {
    this.#discovery ??= this.cdp
      .request("Target.setDiscoverTargets", { discover: true })
      .then(() => undefined, (error: Error) => {
        this.#discovery = undefined;
        throw error;
      });
    if (!signal) return this.#discovery;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    // Cancelling one waiter must not cancel discovery for other Screens.
    try { await Promise.race([this.#discovery, aborted.promise]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  /**
   * A page opened by an owned or pending page belongs to that page's Screen.
   * A registered opener is resolved by window identity; a pending opener already
   * supplies its Screen. Neither title nor geometry selects an owner, and an
   * unknown opener records nothing so Sway parks the pop-up without guessing.
   */
  #onTargetEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Target.targetDestroyed") {
      const targetId = String(params.targetId);
      const reason = new Error("Browser target destroyed during attribution");
      this.#destroyedTargets.add(targetId);
      this.#openerLookups.get(targetId)?.abort(reason);
      for (const [candidate, work] of this.#attributions) {
        if (candidate.targetId === targetId) work.controller.abort(reason);
      }
      this.ownership.removePendingTarget(targetId);
      return;
    }
    if (method !== "Target.targetCreated" && method !== "Target.targetInfoChanged") return;
    const info = params.targetInfo as { targetId?: unknown; type?: unknown; openerId?: unknown } | undefined;
    if (info === null || typeof info !== "object") return;
    if (info.type !== "page" || typeof info.targetId !== "string") return;
    const { targetId, openerId } = info;
    if (method === "Target.targetCreated") this.#destroyedTargets.delete(targetId);
    if (this.#destroyedTargets.has(targetId) || this.#failedAttributions.has(targetId)) return;
    if (this.#openerLookups.has(targetId) || this.ownership.pendingTargets().some(candidate => candidate.targetId === targetId)
      || this.ownership.ownedWindows().some(owner => owner.targetId === targetId)) return;
    if (typeof openerId !== "string") {
      // Only a new target captures the trusted launch/Web Control context.
      // An old ownerless target changing its metadata cannot acquire a later lease.
      if (method === "Target.targetCreated") {
        const owner = this.options.ownerForNewTarget?.(targetId);
        if (owner !== undefined) this.ownership.recordPendingTarget(owner, targetId);
      }
      return;
    }
    const controller = new AbortController();
    this.#openerLookups.set(targetId, controller);
    const result = this.#attributePopup(targetId, openerId, controller.signal).catch(() => {}).finally(() => {
      if (this.#openerLookups.get(targetId) === controller) this.#openerLookups.delete(targetId);
      this.#openerResults.delete(targetId);
    });
    this.#openerResults.set(targetId, result);
  }

  /** Resolve opener ownership against a lifetime snapshot, never a window count or event age. */
  async #attributePopup(targetId: string, openerId: string, targetSignal: AbortSignal): Promise<void> {
    // A launch or popup can open another page before its own native window is
    // stamped. Its pending Screen owner is already authoritative; do not wait
    // for a CDP window to enter the registered-window snapshot below.
    const pendingOpener = this.ownership.pendingTargets().find(candidate => candidate.targetId === openerId);
    if (pendingOpener) {
      this.#lifetime.signal.throwIfAborted();
      targetSignal.throwIfAborted();
      this.ownership.surfaceSignal(pendingOpener.surfaceId).throwIfAborted();
      this.ownership.recordPendingTarget(pendingOpener.surfaceId, targetId);
      return;
    }
    // For an opener tab not yet observed by the Browser Tool, its Screen is not
    // known until CDP answers. Snapshot each candidate Screen's signal first so
    // even that lookup cannot revive a released/recreated Screen with the same id.
    const owners = new Map(this.ownership.ownedWindows().map(owner => [owner.browserWindowId, {
      ...owner, signal: this.ownership.surfaceSignal(owner.surfaceId),
    }]));
    const openerOwner = [...owners.values()].find(owner => owner.targetId === openerId);
    const surfaceSignals = new Map([
      ...[...owners.values()].map(owner => [owner.surfaceId, owner.signal] as const),
      ...this.ownership.pendingTargets().map(candidate => [candidate.surfaceId, this.ownership.surfaceSignal(candidate.surfaceId)] as const),
    ]);
    const openerResult = this.#openerResults.get(openerId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.any([
        this.#lifetime.signal, targetSignal, AbortSignal.timeout(POPUP_ATTRIBUTION_TIMEOUT_MS),
        ...(openerOwner ? [openerOwner.signal] : []),
      ]);
      try {
        const windowId = await this.#browserWindowId(openerId, signal);
        signal.throwIfAborted();
        // A nested popup can resolve its opener's native identity before that
        // opener has learned its Screen. Wait for that existing discovery, then
        // re-read ownership while retaining the original Screen lifetimes.
        if (openerResult) {
          const aborted = Promise.withResolvers<never>();
          const onAbort = () => aborted.reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          try { await Promise.race([openerResult, aborted.promise]); }
          finally { signal.removeEventListener("abort", onAbort); }
          signal.throwIfAborted();
          if (this.#destroyedTargets.has(openerId)) return;
          const pending = this.ownership.pendingTargets().find(candidate => candidate.targetId === openerId);
          const current = this.ownership.ownerOfBrowserWindow(windowId);
          const surfaceId = pending?.surfaceId ?? current?.surfaceId;
          if (surfaceId === undefined) return;
          const lifetime = surfaceSignals.get(surfaceId);
          if (!lifetime || lifetime.aborted) return;
          this.ownership.recordPendingTarget(surfaceId, targetId);
          return;
        }
        const owner = owners.get(windowId);
        if (!owner || owner.signal.aborted) return;
        if (this.ownership.ownerOfBrowserWindow(windowId)?.surfaceId !== owner.surfaceId) return;
        this.ownership.recordPendingTarget(owner.surfaceId, targetId);
        return;
      } catch (error) {
        if (this.#lifetime.signal.aborted || targetSignal.aborted || openerOwner?.signal.aborted) return;
        if (!signal.aborted) throw error;
      }
    }
  }

  /** A Screen wait includes opener discovery already in flight, before it stamps. */
  async settleOpenerDiscovery(signal: AbortSignal): Promise<void> {
    const abort = Promise.withResolvers<never>();
    const onAbort = () => abort.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { await Promise.race([Promise.all(this.#openerResults.values()), abort.promise]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  /** Candidates for popups, Bot launches and human takeover all use this lifecycle. */
  attributeTarget(candidate: PendingWindowTarget, port: BrowserWindowAttributionPort, signal?: AbortSignal): Promise<OwnedWindow | undefined> {
    const existing = this.#attributions.get(candidate);
    if (existing) return existing.result;
    const controller = new AbortController();
    const combined = AbortSignal.any([
      this.#lifetime.signal, this.ownership.surfaceSignal(candidate.surfaceId),
      ...(signal ? [signal] : []),
    ]);
    const result = Promise.resolve().then(() => attributeBrowserTarget(this.cdp, this.ownership, candidate, port, combined, this.options.stampTimeoutMs ?? 2_000, controller.signal))
      .catch(error => { this.#failedAttributions.add(candidate.targetId); throw error; })
      .finally(() => { this.#attributions.delete(candidate); });
    this.#attributions.set(candidate, { controller, result });
    return result;
  }

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

  async #browserWindowId(targetId: string, signal?: AbortSignal): Promise<number> {
    const { windowId } = await this.cdp.request<TargetWindow>("Browser.getWindowForTarget", { targetId }, undefined, signal ? { signal } : {});
    if (!Number.isInteger(windowId)) throw new Error("Browser returned an invalid window identity");
    return windowId;
  }

  async perform(surfaceId: string, action: BrowserAction, port: BrowserScreenPort, signal?: AbortSignal): Promise<BrowserResult> {
    const screen = this.#screen(surfaceId);
    const timeoutMs = action.name === "wait_for" ? waitTimeout(action.args.timeoutMs) : 30_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([screen.controller.signal, deadline, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      // Pop-up attribution is only as complete as discovery; a closed pipe fails this action anyway.
      await this.#ensureDiscovery(combined).catch(() => combined.throwIfAborted());
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
            // Match in the page so a huge option list never crosses the CDP pipe; only the index returns.
            optionIndex = await this.#elementValue<number>(tab, backendNodeId,
              "function(wanted) { if (this.tagName !== 'SELECT' || this.multiple) throw new Error('select requires a single native select'); return Array.from(this.options).filter(o => !(o.disabled || (o.parentElement.tagName === 'OPTGROUP' && o.parentElement.disabled))).findIndex(o => o.value === wanted || o.label === wanted); }", combined, [value]);
            if (!Number.isSafeInteger(optionIndex) || optionIndex < 0) throw new Error(`No enabled select option matches ${JSON.stringify(value)}`);
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
    this.ownership.releaseSurface(surfaceId);
    const screen = this.#screens.get(surfaceId);
    if (!screen) return;
    screen.controller.abort(new Error("Browser Screen closed"));
    for (const tab of screen.tabs.values()) void this.cdp.request("Target.detachFromTarget", { sessionId: tab.sessionId }).catch(() => {});
    this.#screens.delete(surfaceId);
  }

  close(): void {
    this.#lifetime.abort(new Error("Browser runtime closed"));
    for (const surfaceId of new Set([
      ...this.#screens.keys(),
      ...this.ownership.ownedWindows().map(owner => owner.surfaceId),
      ...this.ownership.pendingTargets().map(candidate => candidate.surfaceId),
    ])) this.dropScreen(surfaceId);
    this.#destroyedTargets.clear();
    this.#failedAttributions.clear();
    this.#unsubscribe();
    this.cdp.close();
  }

  #screen(surfaceId: string): Screen {
    let screen = this.#screens.get(surfaceId);
    if (!screen) {
      screen = { controller: new AbortController(), refs: new Map(), tabs: new Map() };
      this.#screens.set(surfaceId, screen);
    }
    return screen;
  }

  async #scope(surfaceId: string, port: BrowserScreenPort, signal: AbortSignal): Promise<Scope> {
    const screen = this.#screen(surfaceId);
    // Only registrations observed before the native snapshot are eligible for
    // pruning; popup attribution can register windows during the CDP lookups.
    const observedOwnership = this.ownership.windowsFor(surfaceId);
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
    for (const window of observedOwnership) {
      const current = this.ownership.ownerOfBrowserWindow(window.browserWindowId);
      if (current?.surfaceId !== window.surfaceId || current.swayWindowId !== window.swayWindowId || current.targetId !== window.targetId) continue;
      if (!windows.some((candidate) => candidate.id === window.swayWindowId && candidate.pid === browserPid)) {
        this.ownership.releaseWindow(surfaceId, window.swayWindowId);
        screen.refs.clear();
        lostWindow = true;
      }
    }
    const swayWindowOf = new Map(this.ownership.windowsFor(surfaceId).map((window) => [window.browserWindowId, window.swayWindowId]));
    const targetWindows = new Map<string, ComputerWindowListItem>();
    for (const target of pages) {
      const location = locations.get(target.targetId);
      const swayWindowId = location ? swayWindowOf.get(location.windowId) : undefined;
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
    if (!targets.length) {
      // Every window is bound by a launch claim or by the Surface whose page opened
      // it, so an unbound window is something the Agent can fix from this Screen.
      throw new Error(lostWindow
        ? "Browser window is no longer routed to this Screen; take a new snapshot after opening a browser"
        : "No browser window belongs to this Screen; open the page with `browser tabs open` or `open_url` from this Screen");
    }
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
    const checkNavigation = (): void => { if (navigation !== tab.navigation) throw new Error("Page navigated during snapshot; take a new snapshot"); };
    // Walk the AX tree one node's children at a time so a huge page never produces a huge reply.
    // AXNodeIds are only stable between calls while the Accessibility domain is enabled.
    tab.axUsers = (tab.axUsers ?? 0) + 1;
    try {
      await this.cdp.request("Accessibility.enable", {}, tab.sessionId, { signal });
      const { node: root } = await this.cdp.request<{ node: AxNode }>("Accessibility.getRootAXNode", {}, tab.sessionId, { signal });
      checkNavigation();
      const lines: string[] = [];
      let bytes = 0;
      let truncated = false;
      let visited = 0;
      let fetches = 0;
      const seen = new Set([root.nodeId]);
      const stack: { node: AxNode; depth: number }[] = [{ node: root, depth: 0 }];
      while (stack.length) {
        if (++visited > SNAPSHOT_VISIT_NODES) { truncated = true; break; }
        const { node, depth } = stack.pop()!;
        if (!node.ignored) {
          const ref = node.backendDOMNodeId ? `e${++this.#refSequence}` : undefined;
          const states = (node.properties ?? []).filter((property) => ["disabled", "checked", "selected", "expanded", "required", "readonly", "pressed", "focused", "level"].includes(property.name)).map((property) => `${property.name}=${JSON.stringify(property.value.value)}`);
          const line = `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${String(node.role?.value ?? "node")} ${JSON.stringify(node.name?.value ?? "")}${node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : ""}${states.length ? ` ${states.join(" ")}` : ""}`;
          if (lines.length >= SNAPSHOT_LINES || bytes + Buffer.byteLength(line) + 1 > SNAPSHOT_BYTES) { truncated = true; break; }
          lines.push(line);
          bytes += Buffer.byteLength(line) + 1;
          if (ref) screen.refs.set(ref, { backendNodeId: node.backendDOMNodeId!, targetId: tab.targetId });
        }
        const childIds = node.childIds ?? [];
        if (!childIds.length) continue;
        if (++fetches > SNAPSHOT_FETCHES) { truncated = true; break; }
        let children: AxNode[];
        try {
          ({ nodes: children } = await this.cdp.request<{ nodes: AxNode[] }>("Accessibility.getChildAXNodes", { id: node.nodeId }, tab.sessionId, { signal }));
        } catch (error) {
          // A node removed mid-walk invalidates the walk; one enormous child list is only truncation.
          if (error instanceof Error && /invalid id/i.test(error.message)) throw new Error("Page changed during snapshot; take a new snapshot");
          if (!(error instanceof CdpReplyTooLargeError)) throw error;
          truncated = true;
          continue;
        }
        checkNavigation();
        const byId = new Map(children.map((child) => [child.nodeId, child]));
        // Keep the declared child order; anything extra the browser returns (e.g. iframe documents) follows.
        const declared = new Set(childIds);
        const ordered = [...childIds.flatMap((id) => byId.get(id) ?? []), ...children.filter((child) => !declared.has(child.nodeId))]
          .filter((child) => !seen.has(child.nodeId) && seen.add(child.nodeId));
        const childDepth = Math.min(30, depth + (node.ignored ? 0 : 1));
        for (let i = ordered.length - 1; i >= 0; i--) stack.push({ node: ordered[i]!, depth: childDepth });
      }
      if (lines.length === 0 && truncated) throw new CdpReplyTooLargeError("Accessibility.getChildAXNodes", SNAPSHOT_BYTES);
      return { text: lines.join("\n"), ...(truncated ? { truncated: true } : {}) };
    } finally {
      if (--tab.axUsers === 0) void this.cdp.request("Accessibility.disable", {}, tab.sessionId).catch(() => {});
    }
  }

  async #context(tab: Tab, signal: AbortSignal): Promise<number> {
    if (tab.contextId !== undefined) return tab.contextId;
    const { frameTree } = await this.cdp.request<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab.sessionId, { signal });
    const { executionContextId } = await this.cdp.request<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "omarchy-bot-browser" }, tab.sessionId, { signal });
    tab.frameId = frameTree.frame.id;
    tab.contextId = executionContextId;
    return executionContextId;
  }

  async #elementValue<T>(tab: Tab, backendNodeId: number, functionDeclaration: string, signal: AbortSignal, args: unknown[] = []): Promise<T> {
    const executionContextId = await this.#context(tab, signal);
    const { object } = await this.cdp.request<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId, executionContextId }, tab.sessionId, { signal });
    if (!object.objectId) throw new Error("Element no longer exists; take a new snapshot");
    try {
      const response = await this.cdp.request<{ result: { value: T }; exceptionDetails?: { text?: string } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, ...(args.length ? { arguments: args.map((value) => ({ value })) } : {}), returnByValue: true }, tab.sessionId, { signal });
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
