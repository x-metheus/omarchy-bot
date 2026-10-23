import { loadConfig } from "./config.ts";
import { openDb, recoverOnStartup } from "../persistence/db.ts";
import { EventLog } from "../modules/events/eventLog.ts";
import { ThreadsService } from "../modules/threads/threads.ts";
import { AgentsRegistry } from "../modules/agents/registry.ts";
import { BotsService } from "../modules/bots/bots.ts";
import { BotDeletionService } from "../modules/bots/botDeletion.ts";
import { TurnService } from "../modules/turns/turns.ts";
import { MailboxService } from "../modules/mailbox/mailbox.ts";
import { ComputerBroker } from "../modules/computer/broker.ts";
import { BotScreenManager, type BotScreenRuntimeAdapter } from "../modules/computer/botScreenManager.ts";
import { BOT_DESKTOP_ROLLOUT } from "../modules/computer/botDesktopRollout.ts";
import { prepareSwayProductionCutover } from "../modules/computer/leftoverCage.ts";
import { ScreenProjectionService } from "../modules/computer/screenProjection.ts";
import { SwayBotScreenRuntimeAdapter } from "../modules/computer/swayBotScreenRuntime.ts";
import { PortableSwayRuntimeSupply } from "../modules/computer/swayRuntimeSupply.ts";
import { InputDiagnostics } from "../modules/computer/inputDiagnostics.ts";
import { AvatarService } from "../modules/avatars/avatarService.ts";
import { DictationService } from "../modules/dictation/dictationService.ts";
import { AttachmentsService } from "../modules/attachments/attachments.ts";
import { prepareSharedWorkspace } from "../modules/workspace/sharedWorkspace.ts";
import { PluginsService } from "../modules/plugins/plugins.ts";
import { Supervisor } from "../supervision/supervisor.ts";
import { SidecarBroker } from "../modules/devices/sidecarBroker.ts";
import { startHttp, type DaemonServices } from "../api/http.ts";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";

function writeStatusAtomic(statusPath: string, data: unknown): void {
  const tmp = `${statusPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, statusPath);
}

export interface MainOptions {
  botScreenAdapter?: BotScreenRuntimeAdapter;
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
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const applicationUnitRuntimeDir = options.useHostApplicationUnits === false ? undefined : runtimeDir;
  const workersDir = process.env.OMARCHY_BOT_WORKERS_DIR ?? path.resolve(import.meta.dir, "../../../../workers");
  const agentsDir = path.resolve(workersDir);
  let mailbox!: MailboxService;
  const supervisor: Supervisor = new Supervisor(
    {
      onAgentEvent: (agentId, event) => {
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
      computer: process.env.OMARCHY_BOT_COMPUTER_WORKER_DIR ?? path.resolve(agentsDir, "computer"),
    },
  );
  if (options.botScreenAdapter === undefined) {
    await prepareSwayProductionCutover(cfg.botScreenRuntimeDir);
  }
  const productionScreenAdapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: cfg.botScreenRuntimeDir,
    profileRoot: cfg.botScreenProfileDir,
    computerWorkers: supervisor,
    capacity: cfg.botScreenCapacity,
    applicationCwd: prepareSharedWorkspace(cfg.sharedWorkspaceDir),
    runtimeSupply: new PortableSwayRuntimeSupply({ rootDir: cfg.botScreenSwayRuntimeSupplyDir }),
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
    ...(process.env.OMARCHY_BOT_GRIM_BIN === undefined
      ? {}
      : { grimBin: process.env.OMARCHY_BOT_GRIM_BIN }),
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
  let projections!: ScreenProjectionService;

  const events = new EventLog(db);
  const dictation = new DictationService(cfg.dictationDir, cfg.voxtypeBin ?? "voxtype", events);
  const agents: AgentsRegistry = new AgentsRegistry(db, events, { conformanceDir: cfg.conformanceDir, workersAgentsDir: agentsDir }, supervisor);
  const threads: ThreadsService = new ThreadsService(db, events, agents);
  const bots = new BotsService(db, events, agents, threads);
  const attachments = new AttachmentsService(db, cfg.attachmentsDir, agents);
  attachments.gcStaged();
  const avatars = new AvatarService(bots, supervisor, cfg.avatarsDir);
  const plugins = new PluginsService(path.join(cfg.dataDir, "plugins"), cfg.sharedWorkspaceDir, async () => {
    const worker = await supervisor.agentWorker("pi");
    return worker.request({ type: "resources.list", cwd: cfg.sharedWorkspaceDir }, 30_000);
  }, async (input) => {
    const worker = await supervisor.agentWorker("pi");
    return worker.request({ type: "mcp.control", cwd: cfg.sharedWorkspaceDir, ...input }, 90_000);
  }, () => {
    const host = cfg.host.includes(":") && !cfg.host.startsWith("[") ? `[${cfg.host}]` : cfg.host;
    const origin = new URL(`http://${host}:${http.port}`);
    if (origin.hostname === "0.0.0.0") origin.hostname = "127.0.0.1";
    if (origin.hostname === "[::]") origin.hostname = "[::1]";
    return origin.origin;
  });
  const devices = new SidecarBroker(cfg.sharedWorkspaceDir);
  const deviceLiveness = setInterval(() => devices.expire(), 5_000);
  deviceLiveness.unref?.();
  const turns: TurnService = new TurnService(db, events, threads, agents, bots, attachments, supervisor, cfg, plugins, devices);
  mailbox = new MailboxService(db, events, threads, agents, turns);
  const computer = new ComputerBroker(
    db,
    events,
    screens,
    cfg.artifactsDir,
    (surfaceId) => projections.revokeControl(surfaceId),
    (surfaceId) => projections.restoreControl(surfaceId),
  );
  projections = new ScreenProjectionService(
    screens,
    new InputDiagnostics(db),
    (owner) => computer.canAcceptWebControl(owner),
    (owner) => computer.webControlClaimed(owner),
    (owner) => computer.webControlReleased(owner),
  );
  const botDeletions = new BotDeletionService(
    db,
    events,
    attachments,
    avatars,
    turns,
    threads,
    screens,
    cfg.botDeletionTerminalTimeoutMs,
    projections,
  );
  await screens.recover();

  agents.init();
  mailbox.reconcileStartup();

  // Recheck every agent in the background: probe + conformance gate.
  for (const a of agents.list()) {
    void agents.recheck(a.id).catch(() => {});
  }

  const svc: DaemonServices = {
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
    dictation,
    plugins,
    computer,
    screens,
    projections,
    devices,
    supervisor,
  };
  const http = startHttp(svc);

  const writeStatus = (): void => {
    writeStatusAtomic(cfg.statusPath, {
      ts: new Date().toISOString(),
      agents: agents.list().map((a) => ({ id: a.id, status: a.status })),
      computer: computer.states(),
      botDesktopRollout: BOT_DESKTOP_ROLLOUT,
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

  console.log(`omarchy-bot daemon listening on http://${cfg.host}:${http.port}`);

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
    clearInterval(statusTimer);
    clearInterval(deviceLiveness);
    devices.close();
    await dictation.shutdown();
    computer.shutdown();
    await projections.shutdown();
    await screens.shutdown();
    await supervisor.stopAll(); // close workers
    await plugins.shutdown();
    http.stop(); // close listeners
    db.close(); // flush WAL
    console.log("omarchy-bot daemon stopped");
  };

  const disconnectForRestart = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removeSignalHandlers();
    clearInterval(statusTimer);
    clearInterval(deviceLiveness);
    devices.close();
    await dictation.shutdown();
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

  return { stop, disconnectForRestart, port: http.port, svc };
}

if (import.meta.main) {
  void main();
}
