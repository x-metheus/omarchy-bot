import type { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { openDb, recoverOnStartup } from "../persistence/db.ts";
import { getSetting, setSetting } from "../persistence/settings.ts";
import { EventLog } from "../modules/events/eventLog.ts";
import { ThreadsService } from "../modules/threads/threads.ts";
import { AgentsRegistry } from "../modules/agents/registry.ts";
import { BotsService } from "../modules/bots/bots.ts";
import { BotDeletionService } from "../modules/bots/botDeletion.ts";
import { TurnService } from "../modules/turns/turns.ts";
import { openBotRuntime } from "../modules/runtime/runtime.ts";
import { importMcpOAuthTokensOnce } from "../modules/runtime/mcpOAuthImport.ts";
import { createPiMcpAdapterTokenReader } from "../modules/runtime/mcpOAuthKeyringReader.ts";
import { MailboxService } from "../modules/mailbox/mailbox.ts";
import { ComputerBroker, type ComputerSurfaceOwner } from "../modules/computer/broker.ts";
import { BotScreenManager, type BotScreenRuntimeAdapter } from "../modules/computer/botScreenManager.ts";
import { ScreenProjectionService } from "../modules/computer/screenProjection.ts";
import { ScreenInputLease } from "../modules/computer/screenInputLease.ts";
import { SwayBotScreenRuntimeAdapter } from "../modules/computer/swayBotScreenRuntime.ts";
import { PortableSwayRuntimeSupply } from "../modules/computer/swayRuntimeSupply.ts";
import { ignoredBrowserSelectionNotice } from "../modules/computer/browserSupply.ts";
import type { BotComputerAssetSupply } from "../modules/computer/botComputerAssets.ts";
import { InputDiagnostics } from "../modules/computer/inputDiagnostics.ts";
import { AvatarService } from "../modules/avatars/avatarService.ts";
import { AttachmentsService } from "../modules/attachments/attachments.ts";
import { cleanupWorkspace } from "../modules/workspace/cleanup.ts";
import { prepareSharedWorkspace } from "../modules/workspace/sharedWorkspace.ts";
import { PluginsService } from "../modules/plugins/plugins.ts";
import { Supervisor } from "../supervision/supervisor.ts";
import { SidecarBroker } from "../modules/devices/sidecarBroker.ts";
import { PairingService } from "../modules/pairing/pairing.ts";
import { startHttp, type DaemonServices } from "../api/http.ts";
import { writeFileSync, renameSync } from "node:fs";
import { stderr } from "@omarchy-bot/agent-contract";
import path from "node:path";
import type { SurfaceId } from "@omarchy-bot/domain";

function writeStatusAtomic(statusPath: string, data: unknown): void {
  const tmp = `${statusPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, statusPath);
}

export function keyringAccessDisabled(env: Record<string, string | undefined>): boolean {
  return env.OMARCHY_TEST_DISABLE_KEYRING === "1";
}

const MCP_OAUTH_REJECTED_SERVERS_SETTING = "mcpOAuthRejectedServers";
const MAX_MCP_OAUTH_REJECTED_SERVERS = 64;

function readMcpOAuthRejectedServers(db: Database): Set<string> {
  const setting = getSetting(db, MCP_OAUTH_REJECTED_SERVERS_SETTING);
  if (setting !== null) {
    try {
      const values: unknown = JSON.parse(setting);
      if (Array.isArray(values)) {
        const names = new Set(values.filter((value): value is string => typeof value === "string"));
        return new Set([...names].slice(-MAX_MCP_OAUTH_REJECTED_SERVERS));
      }
    } catch { /* Ignore a malformed settings value. */ }
  }
  return new Set();
}

export async function closeRuntimeAfterMcpOAuthImport(importing: Promise<unknown> | undefined, closeRuntime: () => Promise<void>): Promise<void> {
  await importing;
  await closeRuntime();
}

export interface MainOptions {
  botScreenAdapter?: BotScreenRuntimeAdapter;
  botComputerAssetSupply?: BotComputerAssetSupply;
  botScreenCapacity?: number;
  /** Integration harnesses disable host user-systemd; production defaults to enabled. */
  useHostApplicationUnits?: boolean;
  /** Test-only private runtime root; production uses the configured XDG runtime. */
  botScreenRuntimeDir?: string;
}

export async function main(options: MainOptions = {}): Promise<{
  stop: () => Promise<void>;
  disconnectForRestart: () => Promise<void>;
  port: number;
  svc: DaemonServices;
}> {
  const cfg = loadConfig();
  if (options.botScreenCapacity !== undefined) cfg.botScreenCapacity = options.botScreenCapacity;
  if (options.botScreenRuntimeDir !== undefined) cfg.botScreenRuntimeDir = options.botScreenRuntimeDir;
  const db = openDb(cfg);
  recoverOnStartup(db);
  const events = new EventLog(db);
  let plugins!: PluginsService;
  const mcpServers = () => plugins?.mcp.effectiveServers() ?? { revision: "", servers: {}, secrets: [] };
  const runtime = await openBotRuntime(cfg, db, {
    events,
    mcp: {
      servers: mcpServers,
      async prepareServers() {
        await plugins?.prepareServiceCredentials();
        return mcpServers();
      },
    },
    mcpOAuth: {
      initialRejectedServers: readMcpOAuthRejectedServers(db),
      onRejectedChange: (names) => setSetting(db, MCP_OAUTH_REJECTED_SERVERS_SETTING, JSON.stringify(names.slice(-MAX_MCP_OAUTH_REJECTED_SERVERS))),
      onAuthorization: (outcome) => { plugins?.handleNativeAuthorization(outcome); },
    },
  });
  const sharedWorkspaceDir = prepareSharedWorkspace(cfg.sharedWorkspaceDir);
  try {
    cleanupWorkspace({ workspaceDir: cfg.sharedWorkspaceDir, dataDir: cfg.dataDir });
  } catch (error) {
    console.warn("Workspace cleanup failed. It will retry on the next Service start.", error);
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const applicationUnitRuntimeDir = options.useHostApplicationUnits === false ? undefined : runtimeDir;
  const workersDir = process.env.OMARCHY_BOT_WORKERS_DIR ?? path.resolve(import.meta.dir, "../../../../workers");
  const agentsDir = path.resolve(workersDir);
  let mailbox!: MailboxService;
  const supervisor: Supervisor = new Supervisor(
    {
      onAgentEvent: (agentId, event) => {
        if (agentId === "pi" && event.type === "native" && event.capability === "mcp.authorization") {
          plugins.handleNativeAuthorization(event.payload);
          return;
        }
        if (!avatars.onAgentEvent(agentId, event)) turns.onAgentEvent(agentId, event);
      },
      onWorkerCrash: (agentId, err) => {
        events.append("agent", agentId, "agent.worker_crash", { agentId, message: err.message });
        agents.markOffline(agentId, err.message);
        turns.onAgentWorkerCrash(agentId, err);
      },
      onAgentToolFrame: (agentId, frame) =>
        turns.onAgentToolFrame(agentId, frame, mailbox, computer),
    },
    {
      agents: agentsDir,
    },
  );
  const browserSelectionNotice = ignoredBrowserSelectionNotice(process.env);
  if (browserSelectionNotice !== undefined) console.warn(browserSelectionNotice);
  const productionScreenAdapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: cfg.botScreenRuntimeDir,
    profileRoot: cfg.botScreenProfileDir,
    capacity: cfg.botScreenCapacity,
    applicationCwd: sharedWorkspaceDir,
    fontDir: process.env.OMARCHY_BOT_FONT_DIR ?? cfg.botComputerFontSupplyDir,
    browserPackDir: process.env.OMARCHY_BOT_BROWSER_PACK_DIR ?? cfg.botComputerBrowserPackDir,
    ...(options.botComputerAssetSupply === undefined ? {} : { assetSupply: options.botComputerAssetSupply }),
    // Development: point OMARCHY_BOT_SWAY_BUNDLE_DIR at an extracted, pinned bundle.
    runtimeSupply: new PortableSwayRuntimeSupply({
      rootDir: process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR ?? cfg.botScreenSwayRuntimeSupplyDir,
    }),
    ...(applicationUnitRuntimeDir === undefined ? {} : { hostRuntimeDir: applicationUnitRuntimeDir }),
    ...(process.env.OMARCHY_BOT_SWAY_BIN === undefined
      ? {}
      : { swayBin: process.env.OMARCHY_BOT_SWAY_BIN }),
    ...(process.env.OMARCHY_BOT_SWAYMSG_BIN === undefined
      ? {}
      : { swaymsgBin: process.env.OMARCHY_BOT_SWAYMSG_BIN }),
    ...(process.env.OMARCHY_BOT_WAYVNC_BIN === undefined
      ? {}
      : { wayvncBin: process.env.OMARCHY_BOT_WAYVNC_BIN }),
    ...(process.env.OMARCHY_BOT_WLR_RANDR_BIN === undefined
      ? {}
      : { wlrRandrBin: process.env.OMARCHY_BOT_WLR_RANDR_BIN }),
    ...(process.env.OMARCHY_BOT_XWAYLAND_BIN === undefined
      ? {}
      : { xwaylandBin: process.env.OMARCHY_BOT_XWAYLAND_BIN }),
    ...(process.env.OMARCHY_BOT_GRIM_BIN === undefined
      ? {}
      : { grimBin: process.env.OMARCHY_BOT_GRIM_BIN }),
    ...(process.env.OMARCHY_BOT_DBUS_DAEMON_BIN === undefined
      ? {}
      : { dbusDaemonBin: process.env.OMARCHY_BOT_DBUS_DAEMON_BIN }),
    ...(process.env.OMARCHY_BOT_INPUT_HELPER_BIN === undefined
      ? {}
      : { inputHelperBin: process.env.OMARCHY_BOT_INPUT_HELPER_BIN }),
    ...(process.env.OMARCHY_BOT_CAPTURE_HELPER_BIN === undefined
      ? {}
      : { captureHelperBin: process.env.OMARCHY_BOT_CAPTURE_HELPER_BIN }),
    ...(process.env.OMARCHY_BOT_DESKTOP_BIN === undefined
      ? {}
      : { botDesktopBin: process.env.OMARCHY_BOT_DESKTOP_BIN }),
  });
  const screens = new BotScreenManager(
    db,
    options.botScreenAdapter ?? productionScreenAdapter,
    {
      capacity: cfg.botScreenCapacity,
      logicalWidth: cfg.botScreenLogicalWidth,
      logicalHeight: cfg.botScreenLogicalHeight,
    },
  );

  const agents: AgentsRegistry = new AgentsRegistry(db, events, { conformanceDir: cfg.conformanceDir, workersAgentsDir: agentsDir }, supervisor);
  const threads: ThreadsService = new ThreadsService(db, events, agents);
  const bots = new BotsService(db, events, agents, threads);
  const attachments = new AttachmentsService(db, cfg.attachmentsDir, agents);
  attachments.gcStaged();
  const avatars = new AvatarService(bots, supervisor, cfg.avatarsDir);
  plugins = new PluginsService(path.join(cfg.dataDir, "plugins"), cfg.sharedWorkspaceDir, async () => {
    const worker = await supervisor.agentWorker("pi");
    const resources = await worker.request({ type: "resources.list", cwd: cfg.sharedWorkspaceDir }, 30_000);
    if (getSetting(db, "runtime") !== "durable") return resources;
    // Reconciliation can change the configuration revision before Services applies the status.
    plugins.mcp.reconcile();
    return { ...resources, mcp: runtime.mcpStatus() };
  }, async (input) => {
    if (getSetting(db, "runtime") === "durable") return runtime.mcpControl(input);
    const worker = await supervisor.agentWorker("pi");
    return worker.request({ type: "mcp.control", cwd: cfg.sharedWorkspaceDir, ...input }, 90_000);
  }, () => {
    const host = cfg.host.includes(":") && !cfg.host.startsWith("[") ? `[${cfg.host}]` : cfg.host;
    const origin = new URL(`${cfg.tlsCert ? "https" : "http"}://${host}:${http.port}`);
    if (origin.hostname === "0.0.0.0") origin.hostname = "127.0.0.1";
    if (origin.hostname === "[::]") origin.hostname = "[::1]";
    return origin.origin;
  }, (event) => { events.append("plugin", event.accountId ?? event.mcpId ?? event.providerId ?? "plugins", `plugin.authorization_${event.status}`, event); });
  let mcpOAuthImport: Promise<unknown> | undefined;
  // Test fixtures set this guard to avoid opening the host keyring during startup.
  if (!keyringAccessDisabled(process.env) && typeof runtime.mcpControl === "function") {
    const markerKey = "mcpOAuthAdapterImport";
    mcpOAuthImport = importMcpOAuthTokensOnce({
      preparePlugins: async () => (await plugins.prepareServiceCredentials()).failed.length === 0,
      createReader: () => createPiMcpAdapterTokenReader({ get: (options) => Bun.secrets.get(options) }),
      secrets: runtime.secrets,
      snapshot: mcpServers,
      check: (name) => runtime.mcpControl({ action: "connect", server: name })
        .then(({ servers }) => servers.some((server) => server.name === name && server.status === "connected")),
      reportRejected: (name) => runtime.mcpMarkNeedsAuth(name),
      marker: {
        get: () => getSetting(db, markerKey) ?? undefined,
        set: (value) => setSetting(db, markerKey, value),
      },
    }).catch(() => undefined);
  }
  const devices = new SidecarBroker(cfg.sharedWorkspaceDir);
  const pairing = new PairingService(db);
  const pairingHostSecret = pairing.ensureHostSecret(cfg.stateDir);
  const deviceLiveness = setInterval(() => devices.expire(), 5_000);
  deviceLiveness.unref?.();
  const turns: TurnService = new TurnService(db, events, threads, agents, bots, attachments, supervisor, cfg, plugins, devices, runtime);
  mailbox = new MailboxService(db, events, threads, agents, turns, runtime);
  runtime.bindServices({ mailbox, sidecars: devices, plugins });
  const recoveringMail = mailbox.recoverAcceptedMail();
  if (recoveringMail) await recoveringMail;
  else turns.recoverTurns();
  const lease = new ScreenInputLease({
    grant: async (surfaceId, epoch, generation, kind) => {
      const source = await screens.projectionSource(ownerFor(surfaceId));
      if (source === undefined) throw new Error("Bot Screen is unavailable");
      // A grant for a replaced runtime must not arm the new compositor.
      if (generation !== undefined && source.runtimeGeneration !== generation) {
        throw new Error(`stale runtime generation ${generation}`);
      }
      return source.setInputAuthority(epoch, kind);
    },
    deliver: async (surfaceId, epoch, event, sequence = 1, generation) => {
      const source = await screens.projectionSource(ownerFor(surfaceId));
      if (source === undefined) throw new Error("Bot Screen is unavailable");
      if (generation !== undefined && source.runtimeGeneration !== generation) {
        throw new Error(`stale runtime generation ${generation}`);
      }
      await source.input({
        surfaceId,
        runtimeGeneration: source.runtimeGeneration,
        geometryGeneration: source.geometryGeneration,
        controllerEpoch: epoch,
        ...event,
        sequence,
      });
    },
    release: async (surfaceId, epoch, held, nextSequence = 1, generation) => {
      const source = await screens.projectionSource(ownerFor(surfaceId));
      if (source === undefined) return;
      // The old compositor is gone: its held keys die with it.
      if (generation !== undefined && source.runtimeGeneration !== generation) return;
      let sequence = nextSequence;
      const context = {
        surfaceId,
        runtimeGeneration: source.runtimeGeneration,
        geometryGeneration: source.geometryGeneration,
        controllerEpoch: epoch,
      };
      for (const keyCode of held.keys) {
        await source.input({ ...context, sequence: sequence++, type: "key", keyCode, state: "released" });
      }
      for (const button of held.buttons) {
        await source.input({
          ...context,
          sequence: sequence++,
          type: "button",
          x: 0,
          y: 0,
          button,
          state: "released",
        });
      }
      await source.releaseInput(epoch);
    },
    capture: (surfaceId) => screens.capture(ownerFor(surfaceId)),
  });
  const projections = new ScreenProjectionService(screens, new InputDiagnostics(db), lease);
  const computer = new ComputerBroker(db, events, screens, cfg.artifactsDir, lease, projections);
  function ownerFor(surfaceId: SurfaceId): ComputerSurfaceOwner {
    const row = db.query(`SELECT bot_id FROM bot_surfaces WHERE surface_id = ?`).get(surfaceId) as { bot_id: string } | null;
    if (row === null) throw new Error("unknown Computer Surface");
    return { botId: row.bot_id, surfaceId };
  }
  const botDeletions = new BotDeletionService(
    db,
    events,
    attachments,
    avatars,
    turns,
    threads,
    screens,
    cfg.sharedWorkspaceDir,
    { secrets: runtime.secrets, terminalWaitTimeoutMs: cfg.botDeletionTerminalTimeoutMs, projections },
  );
  await screens.recover();

  agents.init();
  mailbox.reconcileStartup();
  if (recoveringMail) turns.recoverTurns();

  // Recheck every agent in the background: probe + conformance gate.
  for (const a of agents.list()) {
    void agents.recheck(a.id).catch(() => {});
  }

  const svc: DaemonServices = {
    ...(runtime.approvals ? { approvals: runtime.approvals } : {}),
    credentials: runtime.credentials,
    secrets: runtime.secrets,
    cfg,
    db,
    events,
    agents,
    bots,
    botDeletions,
    threads,
    turns,
    avatars,
    attachments,
    plugins,
    computer,
    screens,
    projections,
    devices,
    pairing,
    pairingHostSecret,
    supervisor,
  };
  const http = startHttp(svc);

  const writeStatus = (): void => {
    writeStatusAtomic(cfg.statusPath, {
      ts: new Date().toISOString(),
      agents: agents.list().map((a) => ({ id: a.id, status: a.status })),
      computer: computer.states(),
    });
  };
  try {
    writeStatus();
  } catch {
    /* status file is best-effort */
  }

  // Periodic status file for the future bar widget (decoupled pattern from research.md §3).
  const statusTimer = setInterval(() => {
    try {
      writeStatus();
    } catch {
      /* status file is best-effort */
    }
  }, 2000);
  statusTimer.unref?.();

  console.log(`omarchy-bot daemon listening on ${cfg.tlsCert ? "https" : "http"}://${cfg.host}:${http.port}`);

  let stopping = false;
  const onInterrupt = (): void => void stop();
  const onTerminate = (): void => void disconnectForRestart();
  const removeSignalHandlers = (): void => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removeSignalHandlers();
    // Safe shutdown order: stop new work before revoking shared resources.
    // A teardown that cannot kill one child must not skip the rest.
    clearInterval(statusTimer);
    clearInterval(deviceLiveness);
    devices.close();
    mailbox.pauseDispatch();
    await turns.shutdown().catch(reportStopFailure("turns"));
    await closeRuntimeAfterMcpOAuthImport(mcpOAuthImport, () => runtime.close()).catch(reportStopFailure("runtime"));
    computer.shutdown();
    await projections.shutdown().catch(reportStopFailure("projections"));
    await screens.shutdown().catch(reportStopFailure("screens"));
    await supervisor.stopAll().catch(reportStopFailure("workers"));
    await plugins.shutdown().catch(reportStopFailure("plugins"));
    http.stop();
    db.close();
    console.log("omarchy-bot daemon stopped");
  };

  const disconnectForRestart = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removeSignalHandlers();
    clearInterval(statusTimer);
    clearInterval(deviceLiveness);
    devices.close();
    mailbox.pauseDispatch();
    await turns.shutdown({ reason: "daemon restart" });
    await closeRuntimeAfterMcpOAuthImport(mcpOAuthImport, () => runtime.close());
    computer.shutdown();
    await projections.shutdown();
    screens.detach();
    await supervisor.stopAll();
    await plugins.shutdown();
    http.stop();
    db.close();
    console.log("omarchy-bot daemon disconnected for restart");
  };

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  function reportStopFailure(step: string): (error: unknown) => void {
    return (error) => stderr(`daemon stop: ${step} failed: ${String(error)}`);
  }


  return { stop, disconnectForRestart, port: http.port, svc };
}

if (import.meta.main) {
  void main();
}
