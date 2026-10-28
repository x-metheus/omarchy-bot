import type {
  ClipboardEvent as ReactClipboardEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Maximize2 } from "lucide-react";
import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { StackItem } from "@astryxdesign/core/Stack";
import { VStack } from "@astryxdesign/core/VStack";
import type { BotViewDto, ComputerViewDto } from "@omarchy-bot/protocol";
import {
  ScreenProjectionConnection,
  type ScreenExpandedView,
  type ScreenProjectionState,
} from "../lib/screenProjection.ts";
import RFB from "@novnc/novnc";
import { getShell } from "../lib/shell.ts";
import { MacOSKeyMapping } from "../lib/keyMapping.ts";

export interface ComputerSurfaceProps {
  bot: Pick<BotViewDto, "id" | "name">;
  view: ComputerViewDto;
  projectionUrl: string;
  busy?: boolean;
  error?: string;
  loading?: boolean;
  onRetry?: () => void;
  onRequestClose: () => void;
  onTakeControl: () => Promise<boolean>;
  onReturnToBot: () => Promise<boolean>;
}

const MAX_EXPANDED_RECONNECTS = 3;
const EXPANDED_CONNECTION_STABILITY_MS = 10_000;

function noVncDisconnectMessage(event: Event): string {
  const clean = event instanceof CustomEvent
    && event.detail !== null
    && typeof event.detail === "object"
    && "clean" in event.detail
    && event.detail.clean === true;
  return clean
    ? "The Bot Screen RFB server closed the view connection."
    : "The browser’s Bot Screen RFB decoder disconnected unexpectedly.";
}

function noVncSecurityMessage(event: Event): string {
  if (
    event instanceof CustomEvent
    && event.detail !== null
    && typeof event.detail === "object"
    && "reason" in event.detail
    && typeof event.detail.reason === "string"
  ) {
    return `The Bot Screen RFB security handshake failed: ${event.detail.reason}`;
  }
  return "The Bot Screen RFB security handshake failed.";
}


function expandedViewport(dialog: HTMLDialogElement): Element | null {
  return dialog.querySelector("[data-testid='computer-expanded-view']");
}

const STATE_LABELS: Record<ComputerViewDto["state"], string> = {
  starting: "Screen starting",
  ready: "Screen ready",
  "bot-using": "Bot using screen",
  "needs-you": "Needs you",
  "user-control": "You have control",
  unavailable: "Screen unavailable",
};


const localStyles = stylex.create({
  preview: {
    borderRadius: "var(--radius-container)",
    overflow: "hidden",
    backgroundColor: "var(--color-background-surface)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-border)",
  },
  image: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  previewState: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--spacing-4)",
  },
  previewExpand: {
    position: "absolute",
    inset: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "white",
    cursor: "zoom-in",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: "var(--spacing-3)",
  },
  previewExpandLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--spacing-2)",
    paddingBlock: "var(--spacing-2)",
    paddingInline: "var(--spacing-3)",
    borderRadius: "var(--radius-pill)",
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    fontWeight: 600,
  },
  webControlDialog: {
    width: "100vw",
    height: "100vh",
    maxWidth: "none",
    maxHeight: "none",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "#11131a",
    color: "white",
    overflow: "hidden",
  },
  webControlShell: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  },
  webControlViewport: {
    minHeight: 0,
    flexGrow: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    padding: "var(--spacing-3)",
  },
  webControlView: {
    display: "block",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    userSelect: "none",
    touchAction: "none",
  },
  webControlAction: {
    color: "inherit",
  },
  webControlToolbar: {
    flexShrink: 0,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: "rgba(255, 255, 255, 0.18)",
    backgroundColor: "rgba(0, 0, 0, 0.32)",
  },
});
interface ComputerSurfaceContentProps extends Omit<
  ComputerSurfaceProps,
  "projectionUrl" | "onRequestClose" | "onTakeControl" | "onReturnToBot"
> {
  previewOnly: boolean;
  projectionState: ScreenProjectionState;
  projectionError?: string;
  frameUrl?: string;
  screenRetrying: boolean;
  onProjectionRetry: () => void;
  onRetryScreen: () => void;
  onFramePainted: () => void;
  onExpandPreview?: () => void;
  onTakeControl: () => void;
  onContinueTakeover: () => void;
}

function ComputerSurfaceContent({
  bot,
  view,
  busy = false,
  error,
  loading = false,
  onRetry,
  onTakeControl,
  onContinueTakeover,
  previewOnly,
  projectionState,
  projectionError,
  frameUrl,
  screenRetrying,
  onProjectionRetry,
  onRetryScreen,
  onFramePainted,
  onExpandPreview,
}: ComputerSurfaceContentProps): JSX.Element {
  const projectionUnavailable = projectionState === "snapshot" || projectionState === "unavailable";
  const canTakeControl = !previewOnly && view.takeover === "available" && !projectionUnavailable;
  const projectionWaiting =
    screenRetrying || (view.state !== "unavailable" && frameUrl === undefined && !projectionUnavailable);

  return (
    <VStack gap={4} padding={4} aria-busy={loading || busy || projectionWaiting || undefined} data-testid="computer-drawer">
      {!loading && view.state !== "unavailable" && view.state !== "ready" ? (
        <Text color="secondary">{STATE_LABELS[view.state]}</Text>
      ) : null}
      {view.takeoverReason !== undefined ? <Text>{view.takeoverReason}</Text> : null}
      {error !== undefined ? <Banner status="error" title={error} /> : null}
      {projectionUnavailable && frameUrl !== undefined ? (
        <Banner
          status="warning"
          title={`Read-only snapshot — ${projectionError ?? "Live Screen Projection is unavailable."}`}
        />
      ) : null}
      {loading ? (
        <EmptyState
          icon={<Icon icon="clock" size="lg" />}
          title="Opening screen"
          description={`Connecting to ${bot.name}’s screen.`}
          isCompact
        />
      ) : view.state === "unavailable" ? (
        <EmptyState
          icon={<Icon icon={screenRetrying ? "clock" : "warning"} size="lg" />}
          title={screenRetrying ? "Opening screen" : "Screen unavailable"}
          description={
            screenRetrying
              ? `Starting ${bot.name}’s screen.`
              : view.unavailableReason === "capacity"
                ? view.activity ?? "Bot Screen capacity is full."
                : view.activity ?? `Couldn’t start ${bot.name}’s screen.`
          }
          {...(!screenRetrying && onRetry !== undefined
            ? { actions: <Button label="Retry" variant="secondary" onClick={onRetry} /> }
            : !screenRetrying && view.unavailableReason !== "capacity"
              ? { actions: <Button label="Retry" variant="secondary" onClick={onRetryScreen} /> }
              : {})}
          isCompact
        />
      ) : (
        <>
          <AspectRatio ratio={16 / 9} fit="contain" xstyle={localStyles.preview}>
            {frameUrl === undefined ? null : (
              <img
                src={frameUrl}
                alt={`${bot.name} screen`}
                onLoad={onFramePainted}
                {...stylex.props(localStyles.image)}
                data-testid="computer-preview"
              />
            )}
            {onExpandPreview !== undefined && frameUrl !== undefined ? (
              <button
                type="button"
                aria-label="Open Web Control"
                title="Open Web Control"
                onClick={onExpandPreview}
                {...stylex.props(localStyles.previewExpand)}
                data-testid="computer-preview-expand"
              >
                <span {...stylex.props(localStyles.previewExpandLabel)}>
                  <Icon icon={Maximize2} size="sm" color="inherit" />
                  Open Web Control
                </span>
              </button>
            ) : null}
            {frameUrl === undefined ? (
              <div {...stylex.props(localStyles.previewState)}>
                <EmptyState
                  icon={<Icon icon={projectionUnavailable ? "warning" : "clock"} size="lg" />}
                  title={projectionUnavailable ? "Screen didn’t load" : "Opening screen"}
                  description={
                    projectionUnavailable
                      ? projectionError ?? "Couldn’t connect to the Bot Screen."
                      : `Connecting to ${bot.name}’s screen.`
                  }
                  {...(projectionUnavailable
                    ? { actions: <Button label="Retry" variant="secondary" onClick={onProjectionRetry} /> }
                    : {})}
                  isCompact
                />
              </div>
            ) : null}
          </AspectRatio>
        </>
      )}
      <HStack gap={2} justify="end" wrap="wrap">
        {canTakeControl && !loading ? (
          <Button
            label="Take control"
            variant="primary"
            isLoading={busy}
            onClick={onTakeControl}
            data-testid="computer-take-control"
          />
        ) : null}
        {!previewOnly && !projectionUnavailable && view.takeover === "active" && !loading ? (
          <Button
            label="Continue takeover"
            variant="primary"
            isLoading={busy}
            onClick={onContinueTakeover}
          />
        ) : null}
      </HStack>
    </VStack>
  );
}

/**
 * Computer Surface content and projection lifecycle without outer panel chrome.
 * Hosts mount this module only while its containing surface is active.
 */
export function ComputerSurface({
  projectionUrl,
  bot,
  view,
  onRequestClose,
  onTakeControl,
  onReturnToBot,
  ...contentProps
}: ComputerSurfaceProps): JSX.Element {
  const { isMobile: isSmallScreen } = useAppShellMobile();
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [projectionState, setProjectionState] = useState<ScreenProjectionState>("closed");
  const [projectionError, setProjectionError] = useState<string>();
  const [frameProjection, setFrameProjection] = useState<{ surfaceId: string; url: string }>();
  const [rfbView, setRfbView] = useState<ScreenExpandedView>();
  const [controlReady, setControlReady] = useState(false);
  const [projectionAttempt, setProjectionAttempt] = useState(0);
  const [screenRetrying, setScreenRetrying] = useState(false);
  const connectionRef = useRef<ScreenProjectionConnection | undefined>(undefined);
  const frameUrlRef = useRef<{ surfaceId: string; url: string } | undefined>(undefined);
  const selectedSurfaceRef = useRef(view.surfaceId);
  selectedSurfaceRef.current = view.surfaceId;
  const expandedRef = useRef<HTMLDialogElement | null>(null);
  const expandedViewRef = useRef<HTMLDivElement | null>(null);
  const pressedPointersRef = useRef(new Map<number, number>());
  const browserPasteKeysRef = useRef(new Set<string>());
  const macOSKeysRef = useRef(new MacOSKeyMapping());
  const expandedReconnectCountRef = useRef(0);
  const expandedStableTimerRef = useRef<number | undefined>(undefined);

  const replaceFrame = useCallback((surfaceId: string, frame: Blob | undefined): void => {
    const current = frameUrlRef.current;
    if (frame === undefined) {
      if (current?.surfaceId === surfaceId) {
        URL.revokeObjectURL(current.url);
        frameUrlRef.current = undefined;
      }
      setFrameProjection((projection) => projection?.surfaceId === surfaceId ? undefined : projection);
      return;
    }
    if (selectedSurfaceRef.current !== surfaceId) return;
    if (current !== undefined) URL.revokeObjectURL(current.url);
    const next = { surfaceId, url: URL.createObjectURL(frame) };
    frameUrlRef.current = next;
    setFrameProjection(next);
  }, []);
  const frameUrl = frameProjection?.surfaceId === view.surfaceId ? frameProjection.url : undefined;
  const clearBrowserHeldInput = useCallback((): void => {
    for (const pointerId of pressedPointersRef.current.keys()) {
      if (expandedRef.current?.hasPointerCapture(pointerId)) {
        expandedRef.current.releasePointerCapture(pointerId);
      }
    }
    pressedPointersRef.current.clear();
    browserPasteKeysRef.current.clear();
    macOSKeysRef.current.clear();
  }, []);
  useLayoutEffect(() => {
    clearTimeout(expandedStableTimerRef.current);
    expandedStableTimerRef.current = undefined;
    expandedReconnectCountRef.current = 0;
    setPreviewExpanded(false);
    setControlReady(false);
    clearBrowserHeldInput();
    return () => {
      clearTimeout(expandedStableTimerRef.current);
      expandedStableTimerRef.current = undefined;
      expandedReconnectCountRef.current = 0;
    };
  }, [clearBrowserHeldInput, view.surfaceId]);
  const requestClose = useCallback((): void => {
    setPreviewExpanded(false);
    setControlReady(false);
    setScreenRetrying(false);
    setProjectionError(undefined);
    onRequestClose();
  }, [onRequestClose]);

  useEffect(() => {
    if (view.state === "unavailable" && (!screenRetrying || view.unavailableReason === "capacity")) {
      connectionRef.current?.close();
      connectionRef.current = undefined;
      replaceFrame(view.surfaceId, undefined);
      setRfbView(undefined);
      setControlReady(false);
      setProjectionState("closed");
      return;
    }
    setProjectionError(undefined);
    const surfaceId = view.surfaceId;
    const connection = new ScreenProjectionConnection(
      projectionUrl,
      { botId: bot.id, surfaceId },
      {
        onState: (state) => {
          if (selectedSurfaceRef.current !== surfaceId) return;
          setProjectionState(state);
          if (state === "unavailable") setScreenRetrying(false);
          if (state === "snapshot" || state === "unavailable") {
            setPreviewExpanded(false);
            setRfbView(undefined);
            setControlReady(false);
          }
        },
        onError: (error) => {
          if (selectedSurfaceRef.current === surfaceId) setProjectionError(error);
        },
        onFrame: (frame) => replaceFrame(surfaceId, frame),
        onExpandedView: (view) => {
          if (selectedSurfaceRef.current === surfaceId) setRfbView(view);
        },
        onControlRevoked: clearBrowserHeldInput,
        onControlStateChange: (active) => {
          if (selectedSurfaceRef.current === surfaceId) setControlReady(active);
        },
        onReconnectRequested: () => {
          if (selectedSurfaceRef.current === surfaceId) {
            setProjectionAttempt((attempt) => attempt + 1);
          }
        },
      },
    );
    connectionRef.current = connection;
    connection.setMode(previewExpanded && !isSmallScreen ? "expanded" : "preview");
    void connection.connect();
    return () => {
      if (connectionRef.current === connection) connectionRef.current = undefined;
      connection.close();
      replaceFrame(surfaceId, undefined);
      setRfbView(undefined);
    };
  }, [
    bot.id,
    clearBrowserHeldInput,
    projectionAttempt,
    projectionUrl,
    screenRetrying,
    replaceFrame,
    view.state === "unavailable",
    view.unavailableReason,
    view.surfaceId,
  ]);

  useEffect(() => {
    if (view.state !== "unavailable" || view.unavailableReason === "capacity") {
      setScreenRetrying(false);
    }
  }, [view.state, view.unavailableReason]);

  useEffect(() => {
    if (isSmallScreen && previewExpanded) setPreviewExpanded(false);
    if (!previewExpanded || isSmallScreen) {
      clearTimeout(expandedStableTimerRef.current);
      expandedStableTimerRef.current = undefined;
      expandedReconnectCountRef.current = 0;
      clearBrowserHeldInput();
    }
    connectionRef.current?.setMode(previewExpanded && !isSmallScreen ? "expanded" : "preview");
  }, [clearBrowserHeldInput, isSmallScreen, previewExpanded]);

  useEffect(() => {
    const dialog = expandedRef.current;
    if (dialog === null) return;
    const shouldOpen = !isSmallScreen && previewExpanded && rfbView !== undefined;
    if (shouldOpen && !dialog.open) dialog.showModal();
    else if (!shouldOpen && dialog.open) dialog.close();
  }, [isSmallScreen, previewExpanded, rfbView]);

  useEffect(() => {
    const host = expandedViewRef.current;
    const connection = connectionRef.current;
    if (host === null || rfbView === undefined || connection === undefined || !previewExpanded) return;
    let disposed = false;
    let client: RFB;
    try {
      client = new RFB(host, rfbView.url, { viewOnly: true, scaleViewport: true });
    } catch {
      connection.expandedFailed(rfbView);
      return;
    }
    const connected = (): void => {
      connection.expandedConnected(rfbView);
      clearTimeout(expandedStableTimerRef.current);
      expandedStableTimerRef.current = window.setTimeout(() => {
        expandedStableTimerRef.current = undefined;
        expandedReconnectCountRef.current = 0;
      }, EXPANDED_CONNECTION_STABILITY_MS);
    };
    const disconnected = (event: Event): void => {
      if (disposed) return;
      clearTimeout(expandedStableTimerRef.current);
      expandedStableTimerRef.current = undefined;
      const message = noVncDisconnectMessage(event);
      const attempt = expandedReconnectCountRef.current + 1;
      if (attempt <= MAX_EXPANDED_RECONNECTS) {
        expandedReconnectCountRef.current = attempt;
        console.warn(`${message} Reconnecting (${attempt}/${MAX_EXPANDED_RECONNECTS}).`);
        connection.expandedDisconnected(rfbView);
        return;
      }
      connection.expandedFailed(
        rfbView,
        `${message} Automatic reconnects were exhausted.`,
      );
    };
    const securityFailed = (event: Event): void => {
      if (!disposed) connection.expandedFailed(rfbView, noVncSecurityMessage(event));
    };
    client.addEventListener("connect", connected);
    client.addEventListener("disconnect", disconnected);
    client.addEventListener("securityfailure", securityFailed);
    client.viewOnly = true;
    client.showDotCursor = true;
    client.scaleViewport = true;
    return () => {
      disposed = true;
      client.removeEventListener("connect", connected);
      client.removeEventListener("disconnect", disconnected);
      client.removeEventListener("securityfailure", securityFailed);
      client.disconnect();
    };
  }, [previewExpanded, rfbView]);

  useEffect(() => {
    if (isSmallScreen || !previewExpanded) return;
    const connection = connectionRef.current;
    requestAnimationFrame(() => expandedRef.current?.focus());
    clearBrowserHeldInput();
    const releaseForBlur = (): void => {
      clearBrowserHeldInput();
      connection?.releaseControl("blur");
    };
    const resumeAfterFocus = (): void => connection?.resumeControl();
    const releaseForNavigation = (): void => {
      clearBrowserHeldInput();
      connection?.suspend("navigation");
    };
    const handleVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        clearBrowserHeldInput();
        connection?.suspend("visibility-loss");
      } else {
        connection?.setMode("expanded");
        connection?.resumeControl();
      }
    };
    window.addEventListener("blur", releaseForBlur);
    window.addEventListener("focus", resumeAfterFocus);
    window.addEventListener("pagehide", releaseForNavigation);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("blur", releaseForBlur);
      window.removeEventListener("focus", resumeAfterFocus);
      window.removeEventListener("pagehide", releaseForNavigation);
      clearBrowserHeldInput();
      document.removeEventListener("visibilitychange", handleVisibility);
      connection?.suspend("teardown");
    };
  }, [clearBrowserHeldInput, isSmallScreen, previewExpanded]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (previewExpanded) setPreviewExpanded(false);
      else requestClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [previewExpanded, requestClose]);

  const sendExpandedMotion = (event: ReactPointerEvent<HTMLDialogElement>): void => {
    const viewport = expandedViewport(event.currentTarget);
    const overControl = event.target instanceof Element && event.target.closest("button") !== null;
    if (viewport === null || (overControl && !pressedPointersRef.current.has(event.pointerId))) return;
    connectionRef.current?.pointerMotion(
      event.clientX,
      event.clientY,
      viewport,
      pressedPointersRef.current.has(event.pointerId),
    );
  };
  const pressExpandedPointer = (event: ReactPointerEvent<HTMLDialogElement>): void => {
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    const viewport = expandedViewport(event.currentTarget);
    if (viewport === null || event.button < 0 || event.button > 2) return;
    event.currentTarget.focus();
    const sent = connectionRef.current?.pointerButton(
      event.clientX,
      event.clientY,
      viewport,
      event.button,
      "pressed",
    ) ?? false;
    if (!sent) return;
    event.preventDefault();
    pressedPointersRef.current.set(event.pointerId, event.button);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const releaseExpandedPointer = (event: ReactPointerEvent<HTMLDialogElement>): void => {
    const button = pressedPointersRef.current.get(event.pointerId);
    if (button === undefined) return;
    const viewport = expandedViewport(event.currentTarget);
    const sent = viewport !== null && connectionRef.current?.pointerButton(
      event.clientX,
      event.clientY,
      viewport,
      button,
      "released",
    ) === true;
    pressedPointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (sent) event.preventDefault();
  };
  const scrollExpandedPointer = (event: ReactWheelEvent<HTMLDialogElement>): void => {
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    const viewport = expandedViewport(event.currentTarget);
    if (viewport === null) return;
    event.preventDefault();
    connectionRef.current?.pointerScroll(event.clientX, event.clientY, viewport, event.deltaX, event.deltaY);
  };
  const suppressExpandedMenu = (event: ReactMouseEvent<HTMLDialogElement>): void => {
    if (!(event.target instanceof Element) || event.target.closest("button") === null) event.preventDefault();
  };
  const sendExpandedKey = (event: ReactKeyboardEvent<HTMLDialogElement>, state: "pressed" | "released"): void => {
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    if (state === "pressed" && event.code === "KeyV" && (event.ctrlKey || event.metaKey)) {
      browserPasteKeysRef.current.add(event.code);
      return;
    }
    if (state === "released" && browserPasteKeysRef.current.delete(event.code)) return;
    const mapping = getShell().keyMapping;
    if (event.repeat && mapping.platform() !== "macos") {
      event.preventDefault();
      return;
    }
    const connection = connectionRef.current;
    const sent = mapping.platform() === "macos"
      ? macOSKeysRef.current.transition(event.code, state, mapping.metaSendsSuper(),
          (code, state, modifiers) => connection?.keyTransition(code, state, modifiers) ?? false)
      : connection?.keyTransition(event.code, state, {
          control: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        }) ?? false;
    if (sent) event.preventDefault();
  };
  const pasteExpandedText = (event: ReactClipboardEvent<HTMLDialogElement>): void => {
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    if (connectionRef.current?.paste(event.clipboardData.getData("text/plain")) === true) event.preventDefault();
  };
  const beginTakeover = useCallback((): void => {
    if (isSmallScreen) return;
    void onTakeControl()
      .then((taken) => {
        if (!taken) return;
        setPreviewExpanded(true);
        if (!isSmallScreen) connectionRef.current?.setMode("expanded");
      })
      .catch(() => {});
  }, [isSmallScreen, onTakeControl]);
  const finishTakeover = useCallback((): void => {
    void onReturnToBot()
      .then((returned) => {
        if (returned) setPreviewExpanded(false);
      })
      .catch(() => {});
  }, [onReturnToBot]);
  const retryUnavailableScreen = useCallback((): void => {
    if (view.unavailableReason === "capacity") return;
    setProjectionError(undefined);
    setProjectionState("connecting");
    setScreenRetrying(true);
    setProjectionAttempt((attempt) => attempt + 1);
  }, [view.unavailableReason]);

  const content = (
    <ComputerSurfaceContent
      {...contentProps}
      bot={bot}
      view={view}
      onTakeControl={beginTakeover}
      onContinueTakeover={() => setPreviewExpanded(true)}
      previewOnly={isSmallScreen}
      projectionState={projectionState}
      {...(projectionError === undefined ? {} : { projectionError })}
      {...(frameUrl === undefined ? {} : { frameUrl })}
      screenRetrying={
        screenRetrying
        && view.state === "unavailable"
        && view.unavailableReason !== "capacity"
      }
      onProjectionRetry={() => {
        setProjectionError(undefined);
        setProjectionState("connecting");
        setProjectionAttempt((attempt) => attempt + 1);
      }}
      onRetryScreen={retryUnavailableScreen}
      onFramePainted={() => connectionRef.current?.previewPainted()}
      {...(!isSmallScreen && frameUrl !== undefined && projectionState === "preview"
        ? {
            onExpandPreview:
              view.takeover === "available"
                ? beginTakeover
                : () => setPreviewExpanded(true),
          }
        : {})}
    />
  );
  const expandedDialog = rfbView === undefined ? null : (
    <dialog
      ref={expandedRef}
      aria-label={`Web Control for ${bot.name}`}
      onCancel={(event) => {
        event.preventDefault();
        setPreviewExpanded(false);
      }}
      onPointerMove={sendExpandedMotion}
      onPointerDown={pressExpandedPointer}
      onPointerUp={releaseExpandedPointer}
      onPointerCancel={releaseExpandedPointer}
      onWheel={scrollExpandedPointer}
      onContextMenu={suppressExpandedMenu}
      onKeyDown={(event) => sendExpandedKey(event, "pressed")}
      onKeyUp={(event) => sendExpandedKey(event, "released")}
      onPaste={pasteExpandedText}
      tabIndex={0}
      data-testid="expanded-web-control"
      {...stylex.props(localStyles.webControlDialog)}
    >
      <div {...stylex.props(localStyles.webControlShell)}>
        <div {...stylex.props(localStyles.webControlViewport)}>
          <div
            ref={expandedViewRef}
            aria-label={`Web Control for ${bot.name}`}
            {...stylex.props(localStyles.webControlView)}
            data-testid="computer-expanded-view"
          />
        </div>
        <HStack gap={2} padding={3} vAlign="center" wrap="wrap" xstyle={localStyles.webControlToolbar}>
          <StackItem size="fill">
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text color="inherit">{bot.name}’s screen</Text>
              <Text color="inherit">
                {controlReady ? "Click, scroll, or type to control" : "Connecting controls…"}
              </Text>
              {view.takeoverReason !== undefined ? <Text color="inherit">{view.takeoverReason}</Text> : null}
            </HStack>
          </StackItem>
          {view.takeover === "active" ? (
            <Button
              label="I'm done"
              variant="primary"
              isLoading={contentProps.busy}
              onClick={finishTakeover}
              data-testid="computer-im-done"
            />
          ) : null}
          <IconButton
            label="Close Web Control"
            tooltip="Close Web Control"
            xstyle={localStyles.webControlAction}
            icon={<Icon icon="close" size="md" color="inherit" />}
            variant="ghost"
            onClick={() => setPreviewExpanded(false)}
          />
        </HStack>
      </div>
    </dialog>
  );

  return (
    <>
      {content}
      {expandedDialog}
    </>
  );
}

