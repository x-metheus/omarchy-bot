/**
 * A Sway window owned by a Surface, with the CDP browser window carrying it.
 * Surface ids are opaque keys here: the Sway adapter passes the domain
 * `SurfaceId`, the Browser Tool the runtime string it was called with.
 */
export interface OwnedWindow {
  surfaceId: string;
  swayWindowId: string;
  browserWindowId: number;
  /** The target that registered this window, when that registration named one. */
  targetId?: string;
}

/** A page target with a known owner, awaiting an exact native-window stamp. */
export interface PendingWindowTarget {
  readonly surfaceId: string;
  readonly targetId: string;
  /** Diagnostic ordering only; time never determines identity or ownership. */
  readonly createdAt: number;
}

interface Entry {
  surfaceId: string;
  swayWindowId: string;
  browserWindowId?: number;
  targetId?: string;
}

/**
 * The one record of which Screen owns which window. Sway routing and the
 * Browser Tool both read and write it, so a window has exactly one owner and a
 * CDP window can never be bound across Screens. Ordinary application windows
 * enter through a launch/routing claim; browser windows complete a pending
 * title-stamp match. Natural page titles never infer an owner.
 */
export class WindowOwnership {
  /** Sway window id → its entry; an entry without a browser window is routed only. */
  #windows = new Map<string, Entry>();
  #bySurface = new Map<string, Set<string>>();
  #browserWindows = new Map<number, string>();
  /** Windows that belong to no Screen: a Screen may neither route nor bind them. */
  #unowned = new Set<string>();
  #parked = new Set<string>();
  #pending = new Map<string, PendingWindowTarget>();
  #matches = new Map<PendingWindowTarget, { swayWindowId: string; browserWindowId: number }>();
  #surfaceControllers = new Map<string, AbortController>();
  #pendingListeners = new Set<(candidate: PendingWindowTarget) => void>();

  /** Scheduling observes this registry; it never keeps a competing ownership map. */
  onPendingTarget(listener: (candidate: PendingWindowTarget) => void): () => void {
    this.#pendingListeners.add(listener);
    return () => { this.#pendingListeners.delete(listener); };
  }

  /** Also covers work begun before the first Browser Tool scope exists. */
  surfaceSignal(surfaceId: string): AbortSignal {
    let controller = this.#surfaceControllers.get(surfaceId);
    if (!controller) {
      controller = new AbortController();
      this.#surfaceControllers.set(surfaceId, controller);
    }
    return controller.signal;
  }

  /** Routes a Sway window to a Surface; false when another Surface already owns it. */
  claim(surfaceId: string, swayWindowId: string): boolean {
    if (this.#unowned.has(swayWindowId) || this.#parked.has(swayWindowId)) return false;
    const entry = this.#windows.get(swayWindowId);
    if (entry !== undefined) return entry.surfaceId === surfaceId;
    this.#windows.set(swayWindowId, { surfaceId, swayWindowId });
    this.#surfaceWindows(surfaceId).add(swayWindowId);
    return true;
  }

  /**
   * Records the CDP browser window and target that carry a Sway window for one
   * Surface. Throws rather than move a window another Screen already owns.
   */
  register(
    surfaceId: string,
    swayWindowId: string,
    browserWindowId: number,
    targetId?: string,
  ): void {
    if (!Number.isInteger(browserWindowId)) {
      throw new Error("Browser returned an invalid window identity");
    }
    if (this.#unowned.has(swayWindowId) || this.#parked.has(swayWindowId)) {
      throw new Error("Browser window is unowned or parked; no Screen may bind it");
    }
    const entry = this.#windows.get(swayWindowId);
    if (entry !== undefined && entry.surfaceId !== surfaceId) {
      throw new Error("Sway window belongs to another Screen");
    }
    const boundSwayWindow = this.#browserWindows.get(browserWindowId);
    if (boundSwayWindow !== undefined && boundSwayWindow !== swayWindowId) {
      throw new Error("Browser window belongs to another Screen");
    }
    if (entry?.browserWindowId !== undefined && entry.browserWindowId !== browserWindowId) {
      throw new Error("Sway window already carries another browser window");
    }
    let owned = entry;
    if (owned === undefined) {
      owned = { surfaceId, swayWindowId };
      this.#windows.set(swayWindowId, owned);
      this.#surfaceWindows(surfaceId).add(swayWindowId);
    }
    owned.browserWindowId = browserWindowId;
    if (targetId !== undefined) owned.targetId = targetId;
    this.#browserWindows.set(browserWindowId, swayWindowId);
  }

  /** Removes one window from `surfaceId`; a Screen releases only its own windows. */
  releaseWindow(surfaceId: string, swayWindowId: string): void {
    const entry = this.#windows.get(swayWindowId);
    if (entry === undefined || entry.surfaceId !== surfaceId) {
      throw new Error("Window does not belong to this Screen");
    }
    this.#drop(entry);
  }

  /** A Surface that is gone owns nothing: its windows and pending pop-ups all go. */
  releaseSurface(surfaceId: string): void {
    this.#surfaceControllers.get(surfaceId)?.abort(new Error("Browser Screen closed"));
    this.#surfaceControllers.delete(surfaceId);
    for (const swayWindowId of [...(this.#bySurface.get(surfaceId) ?? [])]) {
      const entry = this.#windows.get(swayWindowId);
      if (entry !== undefined) this.#drop(entry);
    }
    for (const candidate of this.#pending.values()) {
      if (candidate.surfaceId === surfaceId) this.removePendingTarget(candidate.targetId);
    }
  }

  /** A restarted Bot Computer has a fresh Sway session and a fresh browser pipe. */
  reset(): void {
    this.#windows.clear();
    this.#bySurface.clear();
    this.#browserWindows.clear();
    this.#unowned.clear();
    this.#parked.clear();
    this.#pending.clear();
    this.#matches.clear();
    for (const controller of this.#surfaceControllers.values()) controller.abort(new Error("Bot Computer restarted"));
    this.#surfaceControllers.clear();
  }

  /** The Surface a Sway window is routed to. */
  ownerOfSwayWindow(swayWindowId: string): string | undefined {
    return this.#windows.get(swayWindowId)?.surfaceId;
  }

  /** The Surface and Sway window carrying a CDP browser window. */
  ownerOfBrowserWindow(browserWindowId: number): OwnedWindow | undefined {
    const swayWindowId = this.#browserWindows.get(browserWindowId);
    const entry = swayWindowId === undefined ? undefined : this.#windows.get(swayWindowId);
    if (entry?.browserWindowId !== browserWindowId) return undefined;
    return {
      surfaceId: entry.surfaceId,
      swayWindowId: entry.swayWindowId,
      browserWindowId,
      ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
    };
  }

  /** The CDP browser windows bound to one Surface, oldest first. */
  windowsFor(surfaceId: string): OwnedWindow[] {
    const owned: OwnedWindow[] = [];
    for (const swayWindowId of this.#bySurface.get(surfaceId) ?? []) {
      const entry = this.#windows.get(swayWindowId);
      if (entry?.browserWindowId === undefined) continue;
      owned.push({
        surfaceId: entry.surfaceId,
        swayWindowId: entry.swayWindowId,
        browserWindowId: entry.browserWindowId,
        ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
      });
    }
    return owned;
  }

  /** Snapshot of registered browser windows for cancellable opener resolution. */
  ownedWindows(): OwnedWindow[] {
    return [...this.#bySurface.keys()].flatMap(surfaceId => this.windowsFor(surfaceId));
  }

  /** Marks a Sway window as belonging to no Screen, releasing whatever it had. */
  markUnowned(swayWindowId: string): void {
    const entry = this.#windows.get(swayWindowId);
    if (entry !== undefined) this.#drop(entry);
    this.#parked.delete(swayWindowId);
    this.#unowned.add(swayWindowId);
  }

  /** True when no Screen may route or bind this Sway window. */
  isUnowned(swayWindowId: string): boolean {
    return this.#unowned.has(swayWindowId);
  }

  /** Called only after scratchpad parking succeeds; it grants no ownership. */
  markParked(swayWindowId: string): void {
    if (this.#windows.has(swayWindowId)) throw new Error("Cannot park an owned window for attribution");
    if (!this.#unowned.has(swayWindowId)) this.#parked.add(swayWindowId);
  }

  isParked(swayWindowId: string): boolean { return this.#parked.has(swayWindowId); }

  /** Popup, launch and human-takeover candidates share this one pending record. */
  recordPendingTarget(surfaceId: string, targetId: string, createdAt = Date.now()): PendingWindowTarget {
    const existing = this.#pending.get(targetId);
    if (existing) {
      if (existing.surfaceId !== surfaceId) throw new Error("Pending target belongs to another Screen");
      return existing;
    }
    this.surfaceSignal(surfaceId);
    const candidate = Object.freeze({ surfaceId, targetId, createdAt });
    this.#pending.set(targetId, candidate);
    for (const listener of this.#pendingListeners) listener(candidate);
    return candidate;
  }

  pendingTargets(): PendingWindowTarget[] { return [...this.#pending.values()]; }

  hasPendingTarget(candidate: PendingWindowTarget): boolean {
    return this.#pending.get(candidate.targetId) === candidate;
  }

  removePendingTarget(targetId: string): void {
    const candidate = this.#pending.get(targetId);
    if (candidate) this.#matches.delete(candidate);
    this.#pending.delete(targetId);
  }

  /** A matched native/browser pair may be in flight for only one candidate. */
  reservePendingTarget(candidate: PendingWindowTarget, swayWindowId: string, browserWindowId: number): void {
    if (!this.hasPendingTarget(candidate)) throw new Error("Browser attribution candidate is no longer pending");
    if (!this.#parked.has(swayWindowId) || this.#unowned.has(swayWindowId)) {
      throw new Error("Browser attribution requires a temporarily parked window");
    }
    if (this.#browserWindows.has(browserWindowId)) throw new Error("Browser window belongs to another Screen");
    for (const [other, match] of this.#matches) {
      if (other === candidate) {
        if (match.swayWindowId !== swayWindowId || match.browserWindowId !== browserWindowId) throw new Error("Attribution identity changed");
      } else if (match.swayWindowId === swayWindowId || match.browserWindowId === browserWindowId) {
        throw new Error("Browser window already has an attribution in progress");
      }
    }
    this.#matches.set(candidate, { swayWindowId, browserWindowId });
  }

  /** Only a still-live candidate may turn a temporarily parked window into ownership. */
  completePendingTarget(candidate: PendingWindowTarget, swayWindowId: string, browserWindowId: number): OwnedWindow {
    this.reservePendingTarget(candidate, swayWindowId, browserWindowId);
    this.#parked.delete(swayWindowId);
    try {
      this.register(candidate.surfaceId, swayWindowId, browserWindowId, candidate.targetId);
    } catch (error) {
      this.#parked.add(swayWindowId);
      throw error;
    }
    this.removePendingTarget(candidate.targetId);
    return this.ownerOfBrowserWindow(browserWindowId)!;
  }

  #surfaceWindows(surfaceId: string): Set<string> {
    let windows = this.#bySurface.get(surfaceId);
    if (windows === undefined) {
      windows = new Set();
      this.#bySurface.set(surfaceId, windows);
    }
    return windows;
  }

  #drop(entry: Entry): void {
    this.#windows.delete(entry.swayWindowId);
    if (entry.browserWindowId !== undefined) this.#browserWindows.delete(entry.browserWindowId);
    const windows = this.#bySurface.get(entry.surfaceId);
    windows?.delete(entry.swayWindowId);
    if (windows?.size === 0) this.#bySurface.delete(entry.surfaceId);
  }
}
