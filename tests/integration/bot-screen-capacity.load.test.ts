import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOT_SCREEN_CAPACITY_POLICY } from "../../apps/daemon/src/bootstrap/config.ts";
import type { ProjectionLoadMetrics } from "../../apps/daemon/src/modules/computer/screenProjection.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, apiStatus, authedFetch, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import {
  buildFinalWebClient,
  FinalWebBrowserHarness,
  type BrowserSurfaceSession,
  type BrowserWindowMetric,
} from "./helpers/bot-screen-browser-load.ts";
import {
  requireDefaultProjectionEvidence,
  requireCompletedOperationalRows,
} from "./helpers/bot-screen-capacity-report.ts";
import { ProjectionClient } from "./helpers/projection-client.ts";
import {
  activeWayvncCount,
  command,
  currentGeneration,
  gpuSnapshot,
  matchingProcessPids,
  percentile,
  resourceWindow,
  unitName,
  until,
  waitScreenReady,
  withTimeout,
  type ResourceWindow,
  type ScreenOwner,
} from "./helpers/bot-screen-load-observe.ts";

const loadTest = process.env.OMARCHY_BOT_REAL_SCREEN_LOAD === "1" ? test : test.skip;
const MATRIX = [1, 2, 4, 8] as const;
type Owner = ScreenOwner;


async function destroyBot(harness: Harness, owner: Owner): Promise<number> {
  const startedAt = performance.now();
  const result = await api<{ status: string; failures?: unknown }>(
    harness,
    "DELETE",
    `/api/bots/${owner.botId}`,
    {},
  );
  if (result.status !== "deleted") {
    throw new Error(`Bot ${owner.botId} was not permanently deleted: ${JSON.stringify(result.failures ?? [])}`);
  }
  if (
    existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, owner.surfaceId))
    || existsSync(path.join(harness.svc.cfg.botScreenProfileDir, owner.surfaceId))
  ) throw new Error(`Screen ${owner.surfaceId} retained runtime state after Bot deletion`);
  return Number((performance.now() - startedAt).toFixed(2));
}

async function killUnit(owner: Owner, generation: number, role: "input" | "compositor"): Promise<void> {
  const result = await command(["systemctl", "--user", "kill", "--signal=KILL", unitName(owner.surfaceId, generation, role)]);
  if (result.status !== 0) throw new Error(`could not crash ${role}: ${result.stderr}`);
}

async function newProcessPid(executableName: string, before: ReadonlySet<number>): Promise<number> {
  return until(() => {
    const candidates = [...matchingProcessPids(executableName)].filter((pid) => !before.has(pid));
    return candidates.length === 1 ? candidates[0] : undefined;
  }, 5_000, `could not identify the new ${executableName} process`);
}

async function crashProcess(pid: number, label: string): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    throw new Error(`could not crash ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await until(
    () => existsSync(`/proc/${pid}`) ? undefined : true,
    5_000,
    `${label} process ${pid} did not exit`,
  );
}

function createBrowserFixture(root: string, browserBinary: string): string {
  const html = path.join(root, "load.html");
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>Bot Screen load</title>
<style>html{font:28px sans-serif;background:#102033;color:#fff}body{margin:0;min-height:24000px;background:repeating-linear-gradient(#102033 0 120px,#284d70 120px 240px)}#status{position:fixed;inset:20px 20px auto 20px;padding:20px;background:#000c;border:3px solid #7df}</style>
<div id="status">ready</div><script>let n=0;const s=document.querySelector('#status');for(const event of ['wheel','pointermove','keydown'])addEventListener(event,()=>{s.textContent=event+':'+(++n);s.style.background=n%2?'#8b1e3f':'#14532d'});</script>`);
  const launcher = path.join(root, "bot-screen-browser");
  writeFileSync(launcher, `#!/bin/sh
exec ${JSON.stringify(browserBinary)} --user-data-dir="$XDG_STATE_HOME/brave" --no-first-run --no-default-browser-check --disable-background-networking --disable-sync --password-store=basic --ozone-platform=wayland --app="file://${html}"
`);
  chmodSync(launcher, 0o755);
  return launcher;
}

async function closeBrowserProjectionSessions(
  harness: Harness,
  sessions: readonly BrowserSurfaceSession[],
): Promise<void> {
  const closePromises = sessions.map((session) =>
    harness.svc.projections.close(session.owner, session.projectionSessionId)
  );
  await Promise.all(sessions.map((session) => session.close()));
  await Promise.all(closePromises);
}

async function runRow(profile: "1080p" | "720p", count: number, durationMs: number): Promise<Record<string, unknown>> {
  const admissionRow = profile === "1080p" && count === BOT_SCREEN_CAPACITY_POLICY.defaultCapacity;
  const harness = await startDaemon(undefined, {
    useProductionBotScreen: true,
    botScreenCapacity: admissionRow ? count : 8,
  });
  const owners: Owner[] = [];
  const clients: ProjectionClient[] = [];
  const browserSessions: BrowserSurfaceSession[] = [];
  const startupMs: number[] = [];
  const teardownMs: number[] = [];
  const repeatedProvisionDestroy: Array<{
    cycle: number;
    destroyedSurfaceId: SurfaceId;
    provisionedSurfaceId: SurfaceId;
    teardownMs: number;
    startupMs: number;
  }> = [];
  const trackedSurfaceIds = new Set<SurfaceId>();
  let overflowOwner: Owner | undefined;
  let browserHarness: FinalWebBrowserHarness | undefined;
  let browserMetadata: Record<string, unknown> | null = null;
  let simultaneousAgentAndWebInputCompleted = false;
  const inputLatenciesMs: number[] = [];
  let cleanup: Record<string, unknown> = { clean: false };
  let rowError: string | undefined;
  let idle!: ResourceWindow;
  let active!: ResourceWindow;
  let staticPreview!: ResourceWindow;
  let frameMetrics: BrowserWindowMetric[] = [];
  let staticPreviewFrameMetrics: BrowserWindowMetric[] = [];
  let churnConnections = 0;
  let churnAttempts = 0;
  const churnFailures: string[] = [];
  let directWebSocketAttempts = 0;
  let directWebSocketSuccesses = 0;
  const directWebSocketFailures: string[] = [];
  const connectExpandedWithRecovery = async (
    owner: Owner,
    label: string,
    kind: "setup" | "churn" | "failure",
  ): Promise<ProjectionClient> => {
    const failures: Error[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let candidate: ProjectionClient | undefined;
      directWebSocketAttempts += 1;
      if (kind === "churn") churnAttempts += 1;
      try {
        candidate = await ProjectionClient.connect(harness.baseUrl, owner, `${label}-attempt-${attempt}`, harness.token);
        await candidate.setMode("expanded");
        if (candidate.rfb?.serverInit === undefined) throw new Error("RFB WebSocket did not complete protocol negotiation");
        directWebSocketSuccesses += 1;
        return candidate;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        const detail = `${kind} surface=${owner.surfaceId} attempt=${attempt}: ${failure.message}`;
        directWebSocketFailures.push(detail);
        if (kind === "churn") churnFailures.push(detail);
        if (candidate !== undefined) await candidate.close().catch(() => undefined);
      }
    }
    throw new AggregateError(
      failures,
      `Screen Projection did not recover ${owner.surfaceId} within three fresh WebSocket attempts`,
    );
  };
  let takeoverCompleted = false;
  let crashes: Array<Record<string, unknown>> = [];
  let admission: Record<string, unknown> | null = null;
  let unopenedNoRuntime = false;
  let idleWayvncProcessesObserved = 0;
  let staticPreviewWayvncProcessesObserved = 0;
  let expandedWayvncProcessesObserved = 0;
  let postExpandedWayvncProcessesObserved = 0;
  const gpuBefore = await gpuSnapshot();
  try {
    const botIds = await Promise.all(Array.from({ length: count }, (_, index) => makeBot(harness, `${profile} load ${count}-${index}`)));
    for (const botId of botIds) {
      const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
      const owner = { botId, surfaceId: bot.surfaceId };
      owners.push(owner);
      trackedSurfaceIds.add(owner.surfaceId);
    }
    unopenedNoRuntime = owners.every((owner) =>
      !existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, owner.surfaceId))
    );
    startupMs.push(...await Promise.all(owners.map((owner) => waitScreenReady(harness, owner))));
    console.log(`Bot Screen load ${profile}/${count}: runtimes ready`);
    const workloadApplication = process.env.OMARCHY_BOT_LOAD_APP_BIN;
    if (workloadApplication === undefined) throw new Error("capacity workload application is unavailable");
    await Promise.all(owners.map((owner, index) =>
      harness.svc.screens.act(
        owner,
        { name: "open_app", args: { app: workloadApplication } },
      )
    ));
    await Bun.sleep(500);
    console.log(`Bot Screen load ${profile}/${count}: visual workloads launched`);
    const generationBySurface = new Map<SurfaceId, number>();
    for (const owner of owners) generationBySurface.set(owner.surfaceId, await currentGeneration(harness, owner));
    if (admissionRow) {
      const overflowBotId = await makeBot(harness, `${profile} capacity overflow`);
      const overflowBot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${overflowBotId}`);
      overflowOwner = { botId: overflowBotId, surfaceId: overflowBot.surfaceId };
      trackedSurfaceIds.add(overflowOwner.surfaceId);
      const openAttempt = harness.svc.screens.open(overflowOwner);
      const rejected = await apiStatus(
        harness,
        "GET",
        `/api/computer/state?botId=${overflowOwner.botId}&surfaceId=${overflowOwner.surfaceId}`,
      );
      admission = {
        capacity: count,
        openAttempt,
        rejected,
        noPartialRuntime: !existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, overflowOwner.surfaceId)),
        activeUnaffected: owners.every((owner) => harness.svc.screens.status(owner).state === "ready"),
        activeEnvelopeMaintained: false,
      };
    }

    idle = await resourceWindow(owners, generationBySurface, Math.min(durationMs, 2_000));
    for (let sample = 0; sample < 10; sample += 1) {
      idleWayvncProcessesObserved += activeWayvncCount();
      await Bun.sleep(50);
    }
    console.log(`Bot Screen load ${profile}/${count}: idle measured`);

    const finalWebBrowser = await FinalWebBrowserHarness.start(
      harness.baseUrl,
      (owner, sessionId) => ({
        projectionFailure: harness.svc.projections.failureDiagnostic(owner, sessionId),
        inputDiagnostics: harness.svc.db.query(
          `SELECT action_category, outcome, redacted_length, latency_ms
           FROM input_diagnostics WHERE surface_id = ? ORDER BY id`,
        ).all(owner.surfaceId),
      }),
      harness.token,
    );
    browserHarness = finalWebBrowser;
    browserMetadata = {
      finalWebClient: true,
      mode: "headless",
      secureContext: true,
      lanEndpoint: finalWebBrowser.lanEndpoint,
      lanInterface: finalWebBrowser.lanInterface,
      browser: finalWebBrowser.browserName,
    };
    browserSessions.push(...await Promise.all(owners.map((owner) => finalWebBrowser.open(owner))));

    await Promise.all(browserSessions.map((session) => session.startWindow()));
    staticPreview = await resourceWindow(owners, generationBySurface, durationMs);
    staticPreviewFrameMetrics = await Promise.all(browserSessions.map((session) => session.finishWindow()));
    for (let sample = 0; sample < 10; sample += 1) {
      staticPreviewWayvncProcessesObserved += activeWayvncCount();
      await Bun.sleep(50);
    }
    console.log(`Bot Screen load ${profile}/${count}: sustained static preview measured`);

    await Promise.all(browserSessions.map((session) => session.expand()));
    await until(
      () => {
        const expanded = owners.filter((owner) =>
          harness.svc.projections.surfaceMedia(owner.surfaceId).expandedViewers === 1
        ).length;
        return expanded === count && activeWayvncCount() === count ? true : undefined;
      },
      5_000,
      `expanded mode did not start exactly ${count} RFB views`,
    );
    expandedWayvncProcessesObserved = activeWayvncCount();
    for (let sample = 0; sample < 4; sample += 1) {
      inputLatenciesMs.push(...await Promise.all(browserSessions.map((session) =>
        session.measureInputToVisible()
      )));
    }
    console.log(`Bot Screen load ${profile}/${count}: browser-painted input latency measured`);

    const productionStarts = browserSessions.map((session) => {
      const metrics = harness.svc.projections.loadMetrics(session.owner, session.projectionSessionId);
      if (metrics === undefined) throw new Error(`projection load metrics unavailable for ${session.owner.surfaceId}`);
      return metrics;
    });
    await Promise.all(browserSessions.map((session) => session.startWindow()));
    active = await resourceWindow(owners, generationBySurface, durationMs, async (deadline) => {
      let step = 0;
      while (performance.now() < deadline) {
        await Promise.all(browserSessions.map((session) => session.movePointer(step)));
        step += 1;
        await Bun.sleep(50);
      }
    });
    const browserMetrics = await Promise.all(browserSessions.map((session) =>
      session.finishWindow({ durationMs: active.durationMs })
    ));
    const productionEnds = browserSessions.map((session) => {
      const metrics = harness.svc.projections.loadMetrics(session.owner, session.projectionSessionId);
      if (metrics === undefined) throw new Error(`projection load metrics unavailable for ${session.owner.surfaceId}`);
      return metrics;
    });
    const metricDelta = (
      after: ProjectionLoadMetrics,
      before: ProjectionLoadMetrics,
      key: Exclude<keyof ProjectionLoadMetrics, "sessionId" | "surfaceId">,
    ): number => after[key] - before[key];
    frameMetrics = browserMetrics.map((browserMetric, index) => {
      const before = productionStarts[index]!;
      const after = productionEnds[index]!;
      const browserReceives = metricDelta(after, before, "browserReceives");
      const browserDecodes = metricDelta(after, before, "browserDecodes");
      const browserPaints = metricDelta(after, before, "browserPaints");
      const captureLatencySamples = metricDelta(after, before, "captureLatencySamples");
      const captureLatencyTotalMs = metricDelta(after, before, "captureLatencyTotalMs");
      const captureToPaintLatencySamples = metricDelta(after, before, "captureToPaintLatencySamples");
      const captureToPaintLatencyTotalMs = metricDelta(after, before, "captureToPaintLatencyTotalMs");
      return {
        ...browserMetric,
        captureAttempts: metricDelta(after, before, "captureAttempts"),
        sourceFrames: metricDelta(after, before, "sourceFrames"),
        browserReceives,
        browserDecodes,
        browserPaints,
        previewFrames: metricDelta(after, before, "previewFrames"),
        previewBytes: metricDelta(after, before, "previewBytes"),
        rfbBytesSent: metricDelta(after, before, "rfbBytesSent"),
        rfbBytesReceived: metricDelta(after, before, "rfbBytesReceived"),
        captureSkips: metricDelta(after, before, "captureSkips"),
        invalidFrames: metricDelta(after, before, "invalidFrames"),
        transportSkips: metricDelta(after, before, "transportSkips"),
        sendFailures: metricDelta(after, before, "sendFailures"),
        unexplainedShortfalls: metricDelta(after, before, "unexplainedShortfalls"),
        captureLatencyMs: {
          samples: captureLatencySamples,
          mean: captureLatencySamples === 0 ? null : Number((captureLatencyTotalMs / captureLatencySamples).toFixed(2)),
          lifetimeMax: Number(after.captureLatencyMaxMs.toFixed(2)),
        },
        captureToPaintLatencyMs: {
          samples: captureToPaintLatencySamples,
          mean: captureToPaintLatencySamples === 0
            ? null
            : Number((captureToPaintLatencyTotalMs / captureToPaintLatencySamples).toFixed(2)),
          lifetimeMax: Number(after.captureToPaintLatencyMaxMs.toFixed(2)),
        },
      };
    });
    console.log(`Bot Screen load ${profile}/${count}: final-client RFB browser delivery measured`);

    inputLatenciesMs.push(...await Promise.all(browserSessions.map((session, index) =>
      session.measureInputToVisible(async () => {
        await harness.svc.computer.agentToolAct(
          owners[index]!,
          `simultaneous-turn-${profile}-${count}-${index}`,
          `simultaneous-tool-${profile}-${count}-${index}`,
          { name: "type", args: { text: `AGENT-${index}` } },
          new AbortController().signal,
        );
      })
    )));
    simultaneousAgentAndWebInputCompleted = true;
    console.log(`Bot Screen load ${profile}/${count}: simultaneous Broker Agent and Web input measured`);

    const closedBrowserSessions = browserSessions.splice(0, browserSessions.length);
    await closeBrowserProjectionSessions(harness, closedBrowserSessions);
    await browserHarness.close();
    browserHarness = undefined;
    await until(
      () => activeWayvncCount() === 0 ? true : undefined,
      5_000,
      "expanded browser sessions retained WayVNC processes after disconnect",
    );
    postExpandedWayvncProcessesObserved = activeWayvncCount();

    // Native clients remain only for non-visual Takeover/reconnect fault setup.
    for (const [index, owner] of owners.entries()) {
      const client = await connectExpandedWithRecovery(
        owner,
        `${profile}-${count}-fault-${index}`,
        "setup",
      );
      clients.push(client);
    }

    if (owners.length > 0) {
      const owner = owners[0]!;
      const controller = new AbortController();
      const source = await harness.svc.screens.projectionSource(owner);
      if (source === undefined) throw new Error("Takeover Screen is unavailable");
      const queuedCaptures = Promise.all(Array.from({ length: 3 }, () => source.capture().catch(() => undefined)));
      const pending = harness.svc.computer.agentToolAct(
        owner,
        `takeover-turn-${profile}-${count}`,
        `takeover-tool-${profile}-${count}`,
        { name: "observe", args: {} },
        controller.signal,
      );
      const pendingOutcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await until(
        () => harness.svc.computer.state(owner).takeover === "available" ? true : undefined,
        5_000,
        "Takeover did not become available",
      );
      const query = `botId=${owner.botId}&surfaceId=${owner.surfaceId}`;
      const taken = await withTimeout(
        authedFetch(harness, `${harness.baseUrl}/api/computer/take-control?${query}`, { method: "POST" }),
        10_000,
        "Takeover did not quiesce",
      );
      if (taken.status !== 200) throw new Error(`Takeover failed with ${taken.status}`);
      takeoverCompleted = true;
      controller.abort("load harness completed Takeover");
      await queuedCaptures;
      await withTimeout(pendingOutcome, 10_000, "cancelled Takeover tool did not settle");
    }
    console.log(`Bot Screen load ${profile}/${count}: Takeover completed`);

    for (let churn = 0; churn < 2; churn += 1) {
      const previous = clients.splice(0, clients.length);
      await Promise.all(previous.map((client) => client.close()));
      for (const [index, owner] of owners.entries()) {
        const recovered = await connectExpandedWithRecovery(
          owner,
          `${profile}-${count}-churn-${churn}-${index}`,
          "churn",
        );
        clients.push(recovered);
        churnConnections += 1;
      }
    }
    await Promise.all(clients.splice(0, clients.length).map((client) => client.close()));

    console.log(`Bot Screen load ${profile}/${count}: reconnect churn completed`);
    if (owners.length > 0) {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const destroyed = owners[0]!;
        const cycleTeardownMs = await destroyBot(harness, destroyed);
        const botId = await makeBot(harness, `${profile} reprovision ${count}-${cycle}`);
        const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
        const provisioned: Owner = { botId, surfaceId: bot.surfaceId };
        if (trackedSurfaceIds.has(provisioned.surfaceId)) throw new Error("Bot reprovision reused a destroyed Surface");
        trackedSurfaceIds.add(provisioned.surfaceId);
        const cycleStartupMs = await waitScreenReady(harness, provisioned);
        owners[0] = provisioned;
        repeatedProvisionDestroy.push({
          cycle,
          destroyedSurfaceId: destroyed.surfaceId,
          provisionedSurfaceId: provisioned.surfaceId,
          teardownMs: cycleTeardownMs,
          startupMs: cycleStartupMs,
        });
      }
    }

    const faultOwner = owners[0]!;
    const siblingReady = (): boolean =>
      owners.slice(1).every((owner) => harness.svc.screens.status(owner).state === "ready");
    for (const fault of ["capture-helper"] as const) {
      const executableName = "omarchy-bot-wayland-capture";
      const before = matchingProcessPids(executableName);
      const client = await connectExpandedWithRecovery(
        faultOwner,
        `${profile}-${count}-${fault}-failure`,
        "failure",
      );
      const pid = await newProcessPid(executableName, before);
      await crashProcess(pid, fault);
      const failureReason = "capture-failed";
      await until(
        () => harness.svc.projections.failureDiagnostic(faultOwner, client.session.sessionId)?.reason === failureReason
          ? true
          : undefined,
        5_000,
        `${fault} failure was not surfaced by Screen Projection`,
      );
      const query = `botId=${faultOwner.botId}&surfaceId=${faultOwner.surfaceId}`;
      const snapshot = await authedFetch(harness, `${harness.baseUrl}/api/computer/snapshot?${query}`);
      crashes.push({
        surfaceId: faultOwner.surfaceId,
        role: fault,
        projectionFailure: failureReason,
        snapshotFallback: snapshot.status === 200
          && snapshot.headers.get("content-type") === "image/png"
          && snapshot.headers.get("cache-control") === "no-store",
        isolated: siblingReady(),
      });
      await until(
        () => client.controlSocket.readyState === WebSocket.CLOSED ? true : undefined,
        5_000,
        `${fault} failure did not close its projection control socket`,
      );
    }

    let generation = await currentGeneration(harness, faultOwner);
    await killUnit(faultOwner, generation, "input");
    await until(
      () => harness.svc.screens.status(faultOwner).state === "failed" ? true : undefined,
      5_000,
      "input-helper crash was not observed",
    );
    crashes.push({ surfaceId: faultOwner.surfaceId, role: "input-helper", isolated: siblingReady() });
    startupMs.push(await waitScreenReady(harness, faultOwner));

    generation = await currentGeneration(harness, faultOwner);
    await killUnit(faultOwner, generation, "compositor");
    await until(
      () => harness.svc.screens.status(faultOwner).state === "failed" ? true : undefined,
      5_000,
      "compositor crash was not observed",
    );
    crashes.push({ surfaceId: faultOwner.surfaceId, role: "compositor", isolated: siblingReady() });
  } catch (error) {
    rowError = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.all(clients.splice(0, clients.length).map((client) => client.close()));
    const unclosedBrowserSessions = browserSessions.splice(0, browserSessions.length);
    await closeBrowserProjectionSessions(harness, unclosedBrowserSessions);
    await browserHarness?.close();
    for (const owner of owners) {
      try {
        teardownMs.push(await destroyBot(harness, owner));
      } catch {
        // The final daemon stop below retries any incomplete runtime cleanup.
      }
    }
    if (overflowOwner !== undefined) {
      try {
        teardownMs.push(await destroyBot(harness, overflowOwner));
      } catch {
        // The final daemon stop below retries any incomplete overflow cleanup.
      }
    }
    await harness.stop();
    const unitList = Bun.which("systemctl") === null
      ? ""
      : (await command(["systemctl", "--user", "list-units", "--all", "--plain", "--no-legend", "omarchy-bot-screen-*"])).stdout;
    const trackedSurfaces = [...trackedSurfaceIds];
    cleanup = {
      clean: trackedSurfaces.every((surfaceId) =>
        !existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, surfaceId))
        && !existsSync(path.join(harness.svc.cfg.botScreenProfileDir, surfaceId))
        && !unitList.includes(surfaceId.slice(5))
      ),
      residualRuntimeDirs: trackedSurfaces.filter((surfaceId) => existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, surfaceId))),
      residualProfileDirs: trackedSurfaces.filter((surfaceId) => existsSync(path.join(harness.svc.cfg.botScreenProfileDir, surfaceId))),
      residualUnits: trackedSurfaces.filter((surfaceId) => unitList.includes(surfaceId.slice(5))),
    };
  }
  const gpuAfter = await gpuSnapshot();
  const p50 = percentile(inputLatenciesMs, 0.5);
  const p95 = percentile(inputLatenciesMs, 0.95);
  const captureToBrowserSamples = frameMetrics.flatMap((metric) => metric.captureToBrowserMs);
  const captureToBrowserP50 = percentile(captureToBrowserSamples, 0.5);
  const captureToBrowserP95 = percentile(captureToBrowserSamples, 0.95);
  const captureToBrowser = captureToBrowserSamples.length === 0
    ? {
        available: false,
        reason: "RFB view paints do not carry an absolute capture timestamp",
      }
    : {
        available: true,
        source: "browser-paint",
        samples: captureToBrowserSamples,
        p50: Number(captureToBrowserP50!.toFixed(2)),
        p95: Number(captureToBrowserP95!.toFixed(2)),
      };
  const browserEvidencePresent = frameMetrics.every((metric) =>
    metric.displayedFrames > 0 && metric.renderingSequences.length === metric.displayedFrames
    && metric.rfbBytesSent !== undefined && metric.rfbBytesSent > 0
    && metric.rfbBytesReceived !== undefined && metric.rfbBytesReceived > 0
  );
  const measurementsComplete = rowError === undefined
    && frameMetrics.length === count
    && staticPreviewFrameMetrics.length === count
    && staticPreviewFrameMetrics.every((metric) =>
      metric.displayedFrames > 0 && metric.displayedFps >= 0.5 && metric.displayedFps <= 1.5
    )
    && browserEvidencePresent
    && p50 !== null
    && p95 !== null
    && simultaneousAgentAndWebInputCompleted;
  if (admission !== null) admission.activeEnvelopeMaintained = measurementsComplete;
  const operationalPassed = rowError === undefined
    && frameMetrics.length === count
    && staticPreviewFrameMetrics.length === count
    && staticPreviewFrameMetrics.every((metric) => metric.displayedFrames > 0)
    && idleWayvncProcessesObserved === 0
    && staticPreviewWayvncProcessesObserved === 0
    && expandedWayvncProcessesObserved === count
    && postExpandedWayvncProcessesObserved === 0
    && simultaneousAgentAndWebInputCompleted
    && takeoverCompleted
    && churnConnections === count * 2
    && crashes.length === 4
    && crashes.every((crash) =>
      crash.isolated === true
      && (crash.role === "capture-helper" || crash.role === "wayvnc"
        ? crash.snapshotFallback === true
        : true)
    )
    && repeatedProvisionDestroy.length === 2
    && (cleanup as { clean?: boolean }).clean === true;
  const aggregateCaptureLatencySamples = frameMetrics.reduce(
    (sum, metric) => sum + (metric.captureLatencyMs?.samples ?? 0),
    0,
  );
  const aggregateCaptureToPaintLatencySamples = frameMetrics.reduce(
    (sum, metric) => sum + (metric.captureToPaintLatencyMs?.samples ?? 0),
    0,
  );
  const aggregateMetrics = {
    captureAttempts: frameMetrics.reduce((sum, metric) => sum + (metric.captureAttempts ?? 0), 0),
    sourceFrames: frameMetrics.reduce((sum, metric) => sum + (metric.sourceFrames ?? 0), 0),
    browserReceives: frameMetrics.reduce((sum, metric) => sum + (metric.browserReceives ?? 0), 0),
    browserDecodes: frameMetrics.reduce((sum, metric) => sum + (metric.browserDecodes ?? 0), 0),
    browserPaints: frameMetrics.reduce((sum, metric) => sum + (metric.browserPaints ?? 0), 0),
    previewFrames: frameMetrics.reduce((sum, metric) => sum + (metric.previewFrames ?? 0), 0),
    previewBytes: frameMetrics.reduce((sum, metric) => sum + (metric.previewBytes ?? 0), 0),
    rfbBytesSent: frameMetrics.reduce((sum, metric) => sum + (metric.rfbBytesSent ?? 0), 0),
    rfbBytesReceived: frameMetrics.reduce((sum, metric) => sum + (metric.rfbBytesReceived ?? 0), 0),
    captureSkips: frameMetrics.reduce((sum, metric) => sum + (metric.captureSkips ?? 0), 0),
    invalidFrames: frameMetrics.reduce((sum, metric) => sum + (metric.invalidFrames ?? 0), 0),
    transportSkips: frameMetrics.reduce((sum, metric) => sum + (metric.transportSkips ?? 0), 0),
    sendFailures: frameMetrics.reduce((sum, metric) => sum + (metric.sendFailures ?? 0), 0),
    decodeDrops: frameMetrics.reduce((sum, metric) => sum + metric.decodeDrops, 0),
    paintDrops: frameMetrics.reduce((sum, metric) => sum + metric.paintDrops, 0),
    unexplainedShortfalls: frameMetrics.reduce((sum, metric) => sum + (metric.unexplainedShortfalls ?? 0), 0),
    captureLatencyMs: {
      samples: aggregateCaptureLatencySamples,
      mean: aggregateCaptureLatencySamples === 0
        ? null
        : Number((frameMetrics.reduce(
            (sum, metric) => sum + (metric.captureLatencyMs?.mean ?? 0) * (metric.captureLatencyMs?.samples ?? 0),
            0,
          ) / aggregateCaptureLatencySamples).toFixed(2)),
      maximum: frameMetrics.reduce((maximum, metric) =>
        Math.max(maximum, metric.captureLatencyMs?.lifetimeMax ?? 0), 0),
    },
    captureToPaintLatencyMs: {
      samples: aggregateCaptureToPaintLatencySamples,
      mean: aggregateCaptureToPaintLatencySamples === 0
        ? null
        : Number((frameMetrics.reduce(
            (sum, metric) => sum + (metric.captureToPaintLatencyMs?.mean ?? 0) * (metric.captureToPaintLatencyMs?.samples ?? 0),
            0,
          ) / aggregateCaptureToPaintLatencySamples).toFixed(2)),
      maximum: frameMetrics.reduce((maximum, metric) =>
        Math.max(maximum, metric.captureToPaintLatencyMs?.lifetimeMax ?? 0), 0),
    },
  };
  return {
    profile,
    runtime: "sway",
    screens: count,
    resolution: profile === "1080p" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 },
    durationMs,
    measurementsComplete,
    operationalPassed,
    measurementStatus: measurementsComplete ? "complete" : "incomplete",
    ...(rowError === undefined ? {} : { error: rowError }),
    startupMs: { samples: startupMs, p50: percentile(startupMs, 0.5), p95: percentile(startupMs, 0.95) },
    teardownMs: { samples: teardownMs, p50: percentile(teardownMs, 0.5), p95: percentile(teardownMs, 0.95) },
    repeatedProvisionDestroy,
    inputToVisibleMs: { source: "browser-paint", samples: inputLatenciesMs.map((value) => Number(value.toFixed(2))), p50: p50 === null ? null : Number(p50.toFixed(2)), p95: p95 === null ? null : Number(p95.toFixed(2)) },
    captureToBrowserMs: captureToBrowser,
    frames: frameMetrics,
    browser: browserMetadata,
    staticPreview: {
      frames: staticPreviewFrameMetrics,
      resources: staticPreview ?? null,
      wayvncProcessesObserved: staticPreviewWayvncProcessesObserved,
    },
    idleResources: idle ?? null,
    projectionLifecycle: {
      unopenedNoRuntime,
      idleWayvncProcessesObserved,
      staticPreviewWayvncProcessesObserved,
      expandedWayvncProcessesObserved,
      postExpandedWayvncProcessesObserved,
    },
    directWebSocketRecovery: {
      maxAttemptsPerConnection: 3,
      attempts: directWebSocketAttempts,
      failures: directWebSocketFailures.length,
      failureDetails: directWebSocketFailures,
      successfulFreshFrames: directWebSocketSuccesses,
    },
    activeResources: active ?? null,
    aggregateMetrics,
    admission,
    simultaneousAgentAndWebInputCompleted,
    takeoverCompleted,
    reconnects: churnConnections,
    reconnectRecovery: {
      maxAttemptsPerConnection: 3,
      attempts: churnAttempts,
      failures: churnFailures.length,
      failureDetails: churnFailures,
      successfulFreshFrames: churnConnections,
    },
    crashes,
    gpu: { before: gpuBefore, after: gpuAfter },
    cleanup,
  };
}

async function describeBinary(
  requested: string | undefined,
  fallback: string,
  versionArgs: readonly string[] = ["--version"],
): Promise<Record<string, unknown>> {
  const name = requested ?? fallback;
  const binary = Bun.which(name);
  if (binary === null) return { available: false, requested: name, versionArgs };
  const result = await command([binary, ...versionArgs]);
  return {
    available: result.status === 0,
    requested: name,
    path: binary,
    versionArgs,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function measuredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`measured ${key} was unavailable`);
  }
  return value;
}

function measuredRange(frames: readonly Record<string, unknown>[], key: string): { minimum: number; maximum: number } {
  const values = frames.map((frame) => measuredNumber(frame, key));
  return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

function candidateProjectionEvidence(
  row: Record<string, unknown>,
  rows: readonly Record<string, unknown>[],
  machine: Record<string, unknown>,
  reportPath: string,
  reproducibleCommand: string,
): Record<string, unknown> {
  if (!Array.isArray(row.frames) || row.frames.length === 0) throw new Error("candidate row lacked per-Screen frames");
  const frames = row.frames.map((frame, index) => objectRecord(frame, `frame ${index}`));
  const browser = objectRecord(row.browser, "browser provenance");
  const input = objectRecord(row.inputToVisibleMs, "input-to-visible metrics");
  const captureToBrowser = objectRecord(row.captureToBrowserMs, "capture-to-browser metrics");
  const staticPreview = objectRecord(row.staticPreview, "static preview");
  if (!Array.isArray(staticPreview.frames) || staticPreview.frames.length === 0) {
    throw new Error("candidate row lacked static-preview frames");
  }
  const staticFrames = staticPreview.frames.map((frame, index) => objectRecord(frame, `static frame ${index}`));
  const total = objectRecord(objectRecord(row.activeResources, "active resources").total, "active resource totals");
  const aggregate = objectRecord(row.aggregateMetrics, "aggregate metrics");
  const drops = {
    captureSkips: frames.reduce((sum, frame) => sum + measuredNumber(frame, "captureSkips"), 0),
    invalidFrames: frames.reduce((sum, frame) => sum + measuredNumber(frame, "invalidFrames"), 0),
    transportSkips: frames.reduce((sum, frame) => sum + measuredNumber(frame, "transportSkips"), 0),
    sendFailures: frames.reduce((sum, frame) => sum + measuredNumber(frame, "sendFailures"), 0),
    decodeDrops: frames.reduce((sum, frame) => sum + measuredNumber(frame, "decodeDrops"), 0),
    paintDrops: frames.reduce((sum, frame) => sum + measuredNumber(frame, "paintDrops"), 0),
    unexplainedShortfalls: frames.reduce((sum, frame) => sum + measuredNumber(frame, "unexplainedShortfalls"), 0),
  };
  return {
    schemaVersion: 4,
    sourceReport: { schemaVersion: 4, path: reportPath },
    measuredAt: new Date().toISOString(),
    machine,
    runtime: "sway",
    profile: row.profile,
    resolution: row.resolution,
    candidateCapacity: row.screens,
    capacityRows: rows.map((candidate) => ({
      profile: candidate.profile,
      screens: candidate.screens,
      measurementStatus: candidate.measurementStatus,
      ...(candidate.measurementStatus === "incomplete"
        ? {
            reason: typeof candidate.error === "string"
              ? candidate.error
              : "the measurement scenarios did not complete",
          }
        : {}),
    })),
    durationMs: row.durationMs,
    lifecycleProof: {
      strategy: "permanent-delete-and-fresh-provision",
      cyclesPerRow: Array.isArray(row.repeatedProvisionDestroy) ? row.repeatedProvisionDestroy.length : 0,
    },
    finalClient: {
      built: true,
      browser: machine.browser,
      mode: browser.mode,
      transport: "control WebSocket plus view-only RFB WebSocket",
      lanInterface: browser.lanInterface,
      lanEndpoint: browser.lanEndpoint,
      measurement: "daemon preview/RFB byte counters, noVNC browser callbacks, canvas paint, and canvas readback",
    },
    observedReceivedFps: measuredRange(frames, "receivedFps"),
    observedDecodedFps: measuredRange(frames, "decodedFps"),
    observedDisplayedFps: measuredRange(frames, "displayedFps"),
    observedRfbBytesSent: measuredNumber(aggregate, "rfbBytesSent"),
    observedRfbBytesReceived: measuredNumber(aggregate, "rfbBytesReceived"),
    observedPreviewFrames: measuredNumber(aggregate, "previewFrames"),
    observedPreviewBytes: measuredNumber(aggregate, "previewBytes"),
    observedDrops: drops,
    observedInputToVisibleP50Ms: measuredNumber(input, "p50"),
    observedInputToVisibleP95Ms: measuredNumber(input, "p95"),
    observedCaptureToBrowserMs: captureToBrowser,
    observedCaptureToPaintLatencyMs: aggregate.captureToPaintLatencyMs,
    staticPreviewDisplayedFps: measuredRange(staticFrames, "displayedFps"),
    activeResources: {
      pssMiB: measuredNumber(total, "pssMiB"),
      rssMiB: measuredNumber(total, "rssMiB"),
      cpuPercent: measuredNumber(total, "cpuPercent"),
    },
    admission: row.admission,
    admissionPolicy: BOT_SCREEN_CAPACITY_POLICY,
    performanceBudget: { approved: false, reason: "No matched Sway performance budget has been adopted." },
    reproducibleCommand,
  };
}


loadTest("measures sustained final-stack Bot Screen capacity and admission", async () => {
  const durationMs = Number(process.env.OMARCHY_BOT_LOAD_DURATION_MS ?? 15_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000) {
    throw new Error("OMARCHY_BOT_LOAD_DURATION_MS must be an integer of at least 1000");
  }
  const matrix = process.env.OMARCHY_BOT_LOAD_MATRIX === undefined
    ? [...MATRIX]
    : process.env.OMARCHY_BOT_LOAD_MATRIX.split(",").map(Number);
  if (matrix.length === 0 || matrix.some((count) => !MATRIX.includes(count as typeof MATRIX[number]))) {
    throw new Error("OMARCHY_BOT_LOAD_MATRIX may contain only 1,2,4,8");
  }
  const includeFallback = process.env.OMARCHY_BOT_LOAD_FALLBACK !== "0";
  const reportPath = process.env.OMARCHY_BOT_LOAD_REPORT
    ?? path.join(os.tmpdir(), "omarchy-bot-screen-load-report.json");
  const evidencePath = process.env.OMARCHY_BOT_LOAD_EVIDENCE
    ?? path.join(path.dirname(reportPath), "omarchy-bot-screen-capacity-evidence.json");
  const reproducibleCommand = [
    "OMARCHY_BOT_REAL_SCREEN_LOAD=1",
    "OMARCHY_BOT_LOAD_MATRIX=1,2,4,8",
    "OMARCHY_BOT_LOAD_FALLBACK=1",
    "OMARCHY_BOT_LOAD_LAN_INTERFACE=<lan-interface>",
    "OMARCHY_BOT_LOAD_REPORT=<report.json>",
    "OMARCHY_BOT_LOAD_EVIDENCE=<evidence.json>",
    "bun test tests/integration/bot-screen-capacity.load.test.ts",
  ].join(" ");
  const [sway, browser, gpu] = await Promise.all([
    describeBinary(process.env.OMARCHY_BOT_SWAY_BIN, "sway", ["-v"]),
    describeBinary(process.env.OMARCHY_BOT_LOAD_BROWSER_BIN, "brave"),
    gpuSnapshot(),
  ]);
  const machine: Record<string, unknown> = {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    sway,
    browser,
    gpu,
  };
  const rows: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    reproducibleCommand,
    configuration: {
      runtime: "sway",
      durationMs,
      matrix,
      fallback: includeFallback ? { profile: "720p", screens: 8 } : null,
      admissionPolicy: BOT_SCREEN_CAPACITY_POLICY,
      performanceBudget: "not adopted",
      measurementUnits: "RFB transport bytes and observed browser paints; not video frames",
    },
    machine,
    releaseGate: { passed: false, pending: true },
    operationalGate: { passed: false, pending: true },
    rows,
    chosenDefault: BOT_SCREEN_CAPACITY_POLICY.defaultCapacity,
    candidateProjectionEvidence: null,
  };
  const persistReport = (): void => {
    report.updatedAt = new Date().toISOString();
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  };
  persistReport();

  const prior = {
    application: process.env.OMARCHY_BOT_LOAD_APP_BIN,
    profile: process.env.OMARCHY_BOT_SCREEN_PROFILE,
  };
  let fixtureRoot: string | undefined;
  let executionError: Error | undefined;
  try {
    const browserBinary = process.env.OMARCHY_BOT_LOAD_BROWSER_BIN
      ?? Bun.which("brave")
      ?? Bun.which("chromium")
      ?? Bun.which("chromium-browser");
    if (browserBinary === null || browserBinary === undefined) {
      throw new Error("the real load harness requires Brave or Chromium");
    }
    await buildFinalWebClient(path.resolve(import.meta.dir, "../.."));
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-load-"));
    process.env.OMARCHY_BOT_LOAD_APP_BIN = createBrowserFixture(fixtureRoot, browserBinary);
    process.env.OMARCHY_BOT_SCREEN_PROFILE = "1080p";
    for (const count of matrix) {
      try {
        rows.push(await runRow("1080p", count, durationMs));
      } catch (error) {
        rows.push({
          profile: "1080p",
          screens: count,
          resolution: { width: 1920, height: 1080 },
          measurementsComplete: false,
          operationalPassed: false,
          measurementStatus: "incomplete",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      persistReport();
    }
    if (includeFallback) {
      process.env.OMARCHY_BOT_SCREEN_PROFILE = "720p";
      try {
        rows.push(await runRow("720p", 8, durationMs));
      } catch (error) {
        rows.push({
          profile: "720p",
          screens: 8,
          resolution: { width: 1280, height: 720 },
          measurementsComplete: false,
          operationalPassed: false,
          measurementStatus: "incomplete",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      persistReport();
    }
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
    for (const [name, value] of [
      ["OMARCHY_BOT_LOAD_APP_BIN", prior.application],
      ["OMARCHY_BOT_SCREEN_PROFILE", prior.profile],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const chosenDefault = BOT_SCREEN_CAPACITY_POLICY.defaultCapacity;
  let releaseGateError = executionError;
  let operationalGateError = executionError;
  if (executionError === undefined) {
    try {
      requireDefaultProjectionEvidence(rows, chosenDefault, BOT_SCREEN_CAPACITY_POLICY);
    } catch (error) {
      releaseGateError = error instanceof Error ? error : new Error(String(error));
    }
    try {
      requireCompletedOperationalRows(rows);
    } catch (error) {
      operationalGateError = error instanceof Error ? error : new Error(String(error));
    }
  }
  report.releaseGate = releaseGateError === undefined
    ? { passed: true }
    : { passed: false, error: releaseGateError.message };
  report.operationalGate = operationalGateError === undefined
    ? { passed: true }
    : { passed: false, error: operationalGateError.message };
  const defaultRow = rows.find((row) => row.profile === "1080p" && row.screens === chosenDefault);
  report.admission = defaultRow?.admission ?? null;
  if (releaseGateError === undefined && operationalGateError === undefined && defaultRow !== undefined) {
    const evidence = candidateProjectionEvidence(
      defaultRow,
      rows,
      machine,
      reportPath,
      reproducibleCommand,
    );
    report.candidateProjectionEvidence = evidence;
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    report.evidencePath = evidencePath;
  }
  report.status = "complete";
  persistReport();
  console.log(`BOT_SCREEN_LOAD_REPORT=${reportPath}`);
  if (report.candidateProjectionEvidence !== null) console.log(`BOT_SCREEN_CAPACITY_EVIDENCE=${evidencePath}`);

  if (operationalGateError !== undefined) throw operationalGateError;
  if (releaseGateError !== undefined) throw releaseGateError;
  expect(rows).toHaveLength(matrix.length + (includeFallback ? 1 : 0));
  expect(rows.every((row) => objectRecord(row.cleanup, "row cleanup").clean === true)).toBeTrue();
  expect(report.admission).toMatchObject({
    openAttempt: { state: "stopped", admission: { reason: "capacity", active: chosenDefault, limit: chosenDefault } },
    rejected: {
      body: {
        state: "unavailable",
        activity: `Bot Screen capacity is full (${chosenDefault}/${chosenDefault}).`,
        unavailableReason: "capacity",
        capacity: { active: chosenDefault, limit: chosenDefault },
      },
    },
    noPartialRuntime: true,
    activeUnaffected: true,
    activeEnvelopeMaintained: true,
  });
}, 1_200_000);
