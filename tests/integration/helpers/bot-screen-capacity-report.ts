import type { BotScreenCapacityPolicy } from "../../../apps/daemon/src/bootstrap/config.ts";

export interface BrowserFrameMetric {
  surfaceId: string;
  lanEndpoint: string;
  finalWebClient: true;
  durationMs: number;
  renderingSequences: number[];
  receivedFrames: number;
  decodedFrames: number;
  displayedFrames: number;
  decodeDrops: number;
  paintDrops: number;
  receivedFps: number;
  decodedFps: number;
  displayedFps: number;
  captureAttempts?: number;
  sourceFrames?: number;
  transientCaptureFailures?: number;
  browserReceives?: number;
  browserDecodes?: number;
  browserPaints?: number;
  previewFrames?: number;
  previewBytes?: number;
  rfbBytesSent?: number;
  rfbBytesReceived?: number;
  captureSkips?: number;
  invalidFrames?: number;
  transportSkips?: number;
  sendFailures?: number;
  unexplainedShortfalls?: number;
  captureLatencyMs?: {
    samples: number;
    mean: number | null;
    lifetimeMax: number;
  };
  captureToPaintLatencyMs?: {
    samples: number;
    mean: number | null;
    lifetimeMax: number;
  };
  targetFrameShortfall?: {
    received: number;
    decoded: number;
    displayed: number;
  };
}

export interface BrowserLatencyMetric {
  source: "browser-paint";
  samples: number[];
  p50: number;
  p95: number;
}

export interface CapacityRowForGate {
  runtime?: unknown;
  profile?: unknown;
  screens?: unknown;
  resolution?: unknown;
  targetFps?: unknown;
  measurementsComplete?: unknown;
  frames?: unknown;
  inputToVisibleMs?: unknown;
  captureToBrowserMs?: unknown;
  repeatedProvisionDestroy?: unknown;
  operationalPassed?: unknown;
  error?: unknown;
  staticPreview?: unknown;
  simultaneousAgentAndWebInputCompleted?: unknown;
  takeoverCompleted?: unknown;
  reconnects?: unknown;
  reconnectRecovery?: unknown;
  directWebSocketRecovery?: unknown;
  crashes?: unknown;
  cleanup?: unknown;
  activeResources?: unknown;
  aggregateMetrics?: unknown;
  projectionLifecycle?: unknown;
  admission?: unknown;
}

export function isNonLoopbackLanEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "https:"
      && hostname !== "localhost"
      && hostname !== "0.0.0.0"
      && hostname !== "::"
      && hostname !== "::1"
      && !hostname.startsWith("127.");
  } catch {
    return false;
  }
}
/** RFB transport chunks and canvas paints are different units, not a video pipeline. */
function validBrowserFrames(value: unknown, expectedCount: number): value is BrowserFrameMetric[] {
  if (!Array.isArray(value) || value.length !== expectedCount) return false;
  return value.every((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return false;
    const metric = entry as Partial<BrowserFrameMetric>;
    return typeof metric.surfaceId === "string"
      && metric.finalWebClient === true
      && isNonLoopbackLanEndpoint(metric.lanEndpoint)
      && typeof metric.durationMs === "number" && Number.isFinite(metric.durationMs) && metric.durationMs > 0
      && typeof metric.displayedFrames === "number" && Number.isSafeInteger(metric.displayedFrames) && metric.displayedFrames > 0
      && Array.isArray(metric.renderingSequences) && metric.renderingSequences.length === metric.displayedFrames
      && metric.renderingSequences.every((sequence, index) => Number.isSafeInteger(sequence) && sequence > 0
        && (index === 0 || sequence > metric.renderingSequences![index - 1]!))
      && [metric.receivedFrames, metric.decodedFrames, metric.decodeDrops, metric.paintDrops]
        .every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      && [metric.receivedFps, metric.decodedFps, metric.displayedFps]
        .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
      && typeof metric.rfbBytesSent === "number" && metric.rfbBytesSent > 0
      && typeof metric.rfbBytesReceived === "number" && metric.rfbBytesReceived > 0;
  });
}

function validPaintLatency(value: unknown): value is BrowserLatencyMetric {
  if (
    value === null
    || typeof value !== "object"
    || !("source" in value)
    || !("samples" in value)
    || !("p50" in value)
    || !("p95" in value)
  ) return false;
  return value.source === "browser-paint"
    && Array.isArray(value.samples)
    && value.samples.length > 0
    && value.samples.every((sample: unknown) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0)
    && typeof value.p50 === "number"
    && Number.isFinite(value.p50)
    && value.p50 >= 0
    && typeof value.p95 === "number"
    && Number.isFinite(value.p95)
    && value.p95 >= value.p50;
}

function validProvisionDestroy(value: unknown, minimumCycles: number): boolean {
  if (!Array.isArray(value) || value.length < minimumCycles) return false;
  const destroyed = new Set<string>();
  const provisioned = new Set<string>();
  return value.every((cycle: unknown, index) => {
    if (cycle === null || typeof cycle !== "object") return false;
    const record = cycle as Record<string, unknown>;
    if (
      record.cycle !== index
      || typeof record.destroyedSurfaceId !== "string"
      || typeof record.provisionedSurfaceId !== "string"
      || record.destroyedSurfaceId === record.provisionedSurfaceId
      || destroyed.has(record.destroyedSurfaceId)
      || provisioned.has(record.provisionedSurfaceId)
      || typeof record.teardownMs !== "number"
      || !Number.isFinite(record.teardownMs)
      || record.teardownMs < 0
      || typeof record.startupMs !== "number"
      || !Number.isFinite(record.startupMs)
      || record.startupMs < 0
    ) return false;
    destroyed.add(record.destroyedSurfaceId);
    provisioned.add(record.provisionedSurfaceId);
    return true;
  });
}
function validPeerRecovery(value: unknown, expectedSuccesses: number): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.maxAttemptsPerConnection === 3
    && Number.isSafeInteger(record.attempts)
    && (record.attempts as number) >= expectedSuccesses
    && (record.attempts as number) <= expectedSuccesses * 3
    && Number.isSafeInteger(record.failures)
    && record.failures === (record.attempts as number) - expectedSuccesses
    && record.successfulFreshFrames === expectedSuccesses
    && Array.isArray(record.failureDetails)
    && record.failureDetails.length === record.failures
    && record.failureDetails.every((detail: unknown) => typeof detail === "string" && detail.length > 0);
}


/**
 * Rejects any requested load row that did not finish the non-performance
 * scenarios. Unsupported capacity may miss FPS while still completing them.
 */
export function requireCompletedOperationalRows(rows: readonly CapacityRowForGate[]): void {
  for (const row of rows) {
    const count = row.screens;
    const label = `${String(row.screens)}x${String(row.profile)}`;
    const staticPreview = row.staticPreview;
    const staticFrames = staticPreview !== null
      && typeof staticPreview === "object"
      && "frames" in staticPreview
      && Array.isArray(staticPreview.frames)
      ? staticPreview.frames
      : [];
    const crashes = Array.isArray(row.crashes) ? row.crashes : [];
    const cleanup = row.cleanup;
    const projection = row.projectionLifecycle;
    const resources = row.activeResources;
    const aggregate = row.aggregateMetrics;
    const reconnectRecovery = row.reconnectRecovery;
    const directWebSocketRecovery = row.directWebSocketRecovery;
    const complete = Number.isSafeInteger(count)
      && (count as number) > 0
      && row.error === undefined
      && row.operationalPassed === true
      && Array.isArray(row.frames)
      && row.frames.length === count
      && staticFrames.length === count
      && staticFrames.every((frame: unknown) =>
        frame !== null
        && typeof frame === "object"
        && "displayedFrames" in frame
        && typeof frame.displayedFrames === "number"
        && frame.displayedFrames > 0
      )
      && row.simultaneousAgentAndWebInputCompleted === true
      && row.takeoverCompleted === true
      && row.reconnects === (count as number) * 2
      && reconnectRecovery !== null
      && typeof reconnectRecovery === "object"
      && "maxAttemptsPerConnection" in reconnectRecovery
      && reconnectRecovery.maxAttemptsPerConnection === 3
      && "attempts" in reconnectRecovery
      && Number.isSafeInteger(reconnectRecovery.attempts)
      && (reconnectRecovery.attempts as number) >= (count as number) * 2
      && (reconnectRecovery.attempts as number) <= (count as number) * 2 * 3
      && "failures" in reconnectRecovery
      && Number.isSafeInteger(reconnectRecovery.failures)
      && reconnectRecovery.failures === (reconnectRecovery.attempts as number) - (count as number) * 2
      && "successfulFreshFrames" in reconnectRecovery
      && reconnectRecovery.successfulFreshFrames === (count as number) * 2
      && "failureDetails" in reconnectRecovery
      && Array.isArray(reconnectRecovery.failureDetails)
      && reconnectRecovery.failureDetails.length === reconnectRecovery.failures
      && validPeerRecovery(directWebSocketRecovery, (count as number) * 3 + 2)
      && crashes.length === 4
      && new Set(crashes.flatMap((crash: unknown) =>
        crash !== null && typeof crash === "object" && "role" in crash && typeof crash.role === "string"
          ? [crash.role]
          : []
      )).size === 4
      && crashes.every((crash: unknown) =>
        crash !== null
        && typeof crash === "object"
        && "isolated" in crash
        && crash.isolated === true
        && (!("role" in crash) || (crash.role !== "capture-helper" && crash.role !== "wayvnc")
          || ("snapshotFallback" in crash && crash.snapshotFallback === true))
      )
      && projection !== null
      && typeof projection === "object"
      && "unopenedNoRuntime" in projection
      && projection.unopenedNoRuntime === true
      && "idleWayvncProcessesObserved" in projection
      && projection.idleWayvncProcessesObserved === 0
      && "staticPreviewWayvncProcessesObserved" in projection
      && projection.staticPreviewWayvncProcessesObserved === 0
      && "expandedWayvncProcessesObserved" in projection
      && projection.expandedWayvncProcessesObserved === count
      && "postExpandedWayvncProcessesObserved" in projection
      && projection.postExpandedWayvncProcessesObserved === 0
      && resources !== null
      && typeof resources === "object"
      && "screens" in resources
      && Array.isArray(resources.screens)
      && resources.screens.length === count
      && "total" in resources
      && resources.total !== null
      && typeof resources.total === "object"
      && aggregate !== null
      && typeof aggregate === "object"
      && "rfbBytesSent" in aggregate
      && typeof aggregate.rfbBytesSent === "number"
      && aggregate.rfbBytesSent > 0
      && "rfbBytesReceived" in aggregate
      && typeof aggregate.rfbBytesReceived === "number"
      && aggregate.rfbBytesReceived > 0
      && validProvisionDestroy(row.repeatedProvisionDestroy, 2)
      && cleanup !== null
      && typeof cleanup === "object"
      && "clean" in cleanup
      && cleanup.clean === true;
    if (!complete) throw new Error(`capacity row ${label} did not complete every operational scenario`);
  }
}

/** Selects current evidence for the configured default; this does not approve a performance budget. */
export function requireDefaultProjectionEvidence(
  rows: readonly CapacityRowForGate[],
  configuredDefault: number,
  policy: BotScreenCapacityPolicy,
): CapacityRowForGate {
  if (configuredDefault !== policy.defaultCapacity || configuredDefault > policy.limits[policy.defaultProfile]) {
    throw new Error("measurement selection does not match the configured admission policy");
  }
  const row = rows.find((candidate) => candidate.profile === policy.defaultProfile && candidate.screens === configuredDefault);
  if (row === undefined) throw new Error(`missing the ${configuredDefault}x${policy.defaultProfile} measurement row`);
  if (row.runtime !== "sway" || row.measurementsComplete !== true) {
    throw new Error("current Sway measurement did not complete; historical compositor evidence cannot substitute");
  }
  const resolution = row.resolution;
  const width = policy.defaultProfile === "1080p" ? 1920 : 1280;
  const height = policy.defaultProfile === "1080p" ? 1080 : 720;
  if (resolution === null || typeof resolution !== "object" || !("width" in resolution) || !("height" in resolution)
    || resolution.width !== width || resolution.height !== height) {
    throw new Error("measurement geometry does not match the configured profile");
  }
  if (!validBrowserFrames(row.frames, configuredDefault)) {
    throw new Error("measurement requires bidirectional RFB delivery and real browser paint evidence");
  }
  if (!validProvisionDestroy(row.repeatedProvisionDestroy, 2)) {
    throw new Error("measurement requires repeated permanent deletion and fresh provisioning");
  }
  if (!validPaintLatency(row.inputToVisibleMs)) {
    throw new Error("measurement requires browser-painted input-to-visible samples");
  }
  const admission = row.admission;
  if (admission === null || typeof admission !== "object" || !("capacity" in admission) || admission.capacity !== configuredDefault
    || !("noPartialRuntime" in admission) || admission.noPartialRuntime !== true
    || !("activeUnaffected" in admission) || admission.activeUnaffected !== true) {
    throw new Error("measurement requires pre-provision rejection without disrupting admitted Screens");
  }
  return row;
}
