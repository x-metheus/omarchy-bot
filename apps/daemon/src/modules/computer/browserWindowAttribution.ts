import { randomUUID } from "node:crypto";
import type { CdpPipe } from "./cdpPipe.ts";
import type { OwnedWindow, PendingWindowTarget, WindowOwnership } from "./windowOwnership.ts";

/** The pinned pack decorates native titles; the complete nonce must still match exactly. */
export function matchesBrowserWindowTitleStamp(title: string | undefined, nonce: string): boolean {
  return title === nonce || title === `${nonce} - Google Chrome for Testing`;
}

export interface BrowserWindowAttributionPort {
  /** Observe an exact stamp, with only the pinned pack's fixed native decoration allowed. */
  observeTitle(nonce: string, signal: AbortSignal): Promise<{ swayWindowId: string; title: string }>;
  /** Move this window to the owner's workspace and verify, without focusing the seat. */
  routeAndVerify(surfaceId: string, swayWindowId: string, signal: AbortSignal): Promise<void>;
  /** Re-park a matched window if routing or registration fails; reject on IPC failure. */
  park(swayWindowId: string, signal: AbortSignal): Promise<void>;
}

export class BrowserWindowAttributionError extends Error {
  readonly retryable = true;
  constructor(readonly targetId: string, cause: unknown) {
    super(`Browser window attribution failed for ${targetId}; retry opening the page from this Screen. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "BrowserWindowAttributionError";
  }
}

class TitleRestorationError extends Error {}

/** CDP half of the title-stamp join. The port owns Sway observation and verified movement. */
export async function attributeBrowserTarget(
  cdp: CdpPipe,
  ownership: WindowOwnership,
  candidate: PendingWindowTarget,
  port: BrowserWindowAttributionPort,
  signal: AbortSignal,
  stampTimeoutMs: number,
  targetSignal?: AbortSignal,
): Promise<OwnedWindow | undefined> {
  const actionSignal = AbortSignal.any([signal, ...(targetSignal ? [targetSignal] : [])]);
  let matched: string | undefined;
  try {
    signal.throwIfAborted();
    let attributedWindowId: number | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      try {
        // Destruction cancels the current attempt immediately. The single retry
        // still runs its liveness preflight, but authoritative destruction never
        // recreates a candidate or sends blind CDP requests to the dead target.
        if (targetSignal?.aborted) {
          throw new Error("Browser target destroyed; retry liveness preflight confirms the target is gone", { cause: targetSignal.reason });
        }
        if (!ownership.hasPendingTarget(candidate)) throw new Error("Browser attribution candidate is no longer pending");
        const attemptSignal = AbortSignal.any([actionSignal, AbortSignal.timeout(stampTimeoutMs)]);
        const windowId = await browserWindowId(cdp, candidate.targetId, attemptSignal, stampTimeoutMs);
        if (ownership.ownerOfBrowserWindow(windowId)) {
          // A page joining an owned native window is an ordinary tab.
          return undefined;
        }
        const result = await stampAndObserve(cdp, candidate.targetId, windowId, port, attemptSignal, stampTimeoutMs);
        ownership.reservePendingTarget(candidate, result.swayWindowId, result.browserWindowId);
        matched = result.swayWindowId;
        attributedWindowId = result.browserWindowId;
        break;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof TitleRestorationError && !targetSignal?.aborted) throw error;
        lastError = error;
      }
    }
    if (matched === undefined || attributedWindowId === undefined) throw lastError;
    actionSignal.throwIfAborted();
    if (!ownership.hasPendingTarget(candidate)) throw new Error("Browser attribution candidate is no longer pending");
    if (!ownership.isParked(matched)) throw new Error("Stamped window was not parked for attribution");
    await port.routeAndVerify(candidate.surfaceId, matched, actionSignal);
    actionSignal.throwIfAborted();
    return ownership.completePendingTarget(candidate, matched, attributedWindowId);
  } catch (error) {
    if (matched !== undefined) {
      // Routing may have moved the window before verification/cancellation failed.
      // Cleanup has its own bounded lifetime so releasing a Screen cannot strand it.
      try {
        await port.park(matched, AbortSignal.timeout(stampTimeoutMs));
        if (ownership.hasPendingTarget(candidate)) ownership.markUnowned(matched);
      } catch (parkingError) {
        if (signal.aborted) {
          console.error("Browser attribution cancellation could not re-park its window", parkingError);
          throw signal.reason;
        }
        throw new BrowserWindowAttributionError(candidate.targetId, parkingError);
      }
    }
    if (signal.aborted) throw signal.reason;
    throw new BrowserWindowAttributionError(candidate.targetId, error);
  } finally {
    if (ownership.hasPendingTarget(candidate)) ownership.removePendingTarget(candidate.targetId);
  }
}

async function stampAndObserve(
  cdp: CdpPipe,
  targetId: string,
  expectedBrowserWindowId: number,
  port: BrowserWindowAttributionPort,
  lifetime: AbortSignal,
  timeoutMs: number,
): Promise<{ swayWindowId: string; browserWindowId: number }> {
  const navigation = new AbortController();
  const signal = AbortSignal.any([lifetime, navigation.signal, AbortSignal.timeout(timeoutMs)]);
  let sessionId: string | undefined;
  let contextId: number | undefined;
  let originalTitle: string | undefined;
  let stampSent = false;
  const nonce = `omarchy-bot-window-${randomUUID()}`;
  const unsubscribe = cdp.onEvent((method, params, eventSessionId) => {
    if (eventSessionId !== sessionId || sessionId === undefined) return;
    const frame = params.frame as { parentId?: string } | undefined;
    if (method === "Page.frameNavigated" && frame?.parentId === undefined || method === "DOM.documentUpdated") {
      navigation.abort(new Error("Browser document changed during title attribution"));
    }
  });
  try {
    sessionId = await attach(cdp, targetId, signal, timeoutMs);
    await cdp.request("Page.enable", {}, sessionId, { signal });
    const { frameTree } = await cdp.request<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId, { signal });
    const isolated = await cdp.request<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id, worldName: "omarchy-bot-window-attribution",
    }, sessionId, { signal });
    contextId = isolated.executionContextId;
    if (!Number.isInteger(contextId)) throw new Error("Browser did not create an isolated title context");
    // Read first: a lost reply to the title write must still permit restoration.
    const title = await evaluate(cdp, sessionId, contextId, "document.title", signal);
    if (typeof title !== "string") throw new Error("Browser page title is unavailable");
    originalTitle = title;
    stampSent = true;
    await evaluate(cdp, sessionId, contextId, `document.title = ${JSON.stringify(nonce)}`, signal);
    const observation = await port.observeTitle(nonce, signal);
    signal.throwIfAborted();
    if (!matchesBrowserWindowTitleStamp(observation.title, nonce)) throw new Error("No exact title stamp observed");
    const browserWindow = await browserWindowId(cdp, targetId, signal, timeoutMs);
    if (browserWindow !== expectedBrowserWindowId) throw new Error("Browser target changed native windows during attribution");
    return { swayWindowId: observation.swayWindowId, browserWindowId: browserWindow };
  } finally {
    unsubscribe();
    try {
      if (stampSent && sessionId !== undefined && contextId !== undefined && originalTitle !== undefined && !navigation.signal.aborted) {
        try {
          // A page that already replaced the nonce owns its new title; never overwrite it.
          await evaluate(cdp, sessionId, contextId,
            `if (document.title === ${JSON.stringify(nonce)}) document.title = ${JSON.stringify(originalTitle)}`,
            AbortSignal.timeout(timeoutMs));
        } catch (error) {
          throw new TitleRestorationError(`Browser title restoration failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
    } finally {
      if (sessionId !== undefined) await cdp.request("Target.detachFromTarget", { sessionId }, undefined, { timeoutMs }).catch(() => {});
    }
  }
}

async function browserWindowId(cdp: CdpPipe, targetId: string, signal: AbortSignal, timeoutMs: number): Promise<number> {
  const { windowId } = await cdp.request<{ windowId: number }>("Browser.getWindowForTarget", { targetId }, undefined, { signal, timeoutMs });
  if (!Number.isInteger(windowId)) throw new Error("Browser returned an invalid window identity");
  return windowId;
}

async function evaluate(cdp: CdpPipe, sessionId: string, contextId: number, expression: string, signal: AbortSignal): Promise<unknown> {
  const result = await cdp.request<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
    expression, contextId, returnByValue: true,
  }, sessionId, { signal });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser title evaluation failed");
  return result.result.value;
}

async function attach(cdp: CdpPipe, targetId: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  // A late successful attachment must be detached even when cancellation already returned.
  const attachment = cdp.request<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, { timeoutMs });
  void attachment.then(({ sessionId }) => {
    if (signal.aborted) void cdp.request("Target.detachFromTarget", { sessionId }, undefined, { timeoutMs }).catch(() => {});
  }, () => {});
  try { return (await Promise.race([attachment, cancelled.promise])).sessionId; }
  finally { signal.removeEventListener("abort", onAbort); }
}
