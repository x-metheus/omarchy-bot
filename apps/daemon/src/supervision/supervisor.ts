import path from "node:path";
import type {
  AgentBotMessageToolOutput,
  AgentBotMessageToolRequest,
  AgentComputerToolOutput,
  AgentComputerToolRequest,
  AgentEvent,
  ComputerActPayload,
  ComputerCommand,
  AgentPluginToolRequest,
  AgentPluginToolOutput,
  AgentLocalToolRequest,
  AgentLocalToolOutput,
} from "@omarchy-bot/agent-contract";
import { isSurfaceId, type AgentId, type SurfaceId } from "@omarchy-bot/domain";
import { WorkerClient, sanitizedEnv } from "./workerClient.ts";

export interface SupervisorHooks {
  onAgentEvent: (agentId: AgentId, event: AgentEvent) => void;
  onWorkerCrash: (agentId: AgentId, error: Error) => void;
  onAgentComputerRequest: (
    agentId: AgentId,
    request: AgentComputerToolRequest,
    signal: AbortSignal,
  ) => Promise<AgentComputerToolOutput>;
  onAgentBotMessageRequest: (
    agentId: AgentId,
    request: AgentBotMessageToolRequest,
    signal: AbortSignal,
  ) => Promise<AgentBotMessageToolOutput>;
  onAgentPluginRequest: (
    agentId: AgentId,
    request: AgentPluginToolRequest,
    signal: AbortSignal,
  ) => Promise<AgentPluginToolOutput>;
  onAgentLocalRequest: (
    agentId: AgentId,
    request: AgentLocalToolRequest,
    signal: AbortSignal,
  ) => Promise<AgentLocalToolOutput>;
}

type ComputerActCommand = Extract<ComputerCommand, { type: "act" }>;

export interface ComputerWorkerScope {
  surfaceId: SurfaceId;
  runtimeGeneration: number;
  env: Record<string, string>;
  wrapCommand?: (targetEnvironment: Record<string, string>) => {
    commandPrefix: string[];
    launcherEnvironment: Record<string, string>;
  };
}

export interface SurfaceComputerWorker {
  surfaceId: SurfaceId;
  runtimeGeneration: number;
  exited: Promise<Error>;
  act(action: ComputerActCommand["action"], inputAuthority?: ComputerActCommand["inputAuthority"]): Promise<ComputerActPayload>;
  stop(): Promise<void>;
}

interface ComputerWorkerEntry {
  runtimeGeneration: number;
  client: WorkerClient;
  handle: SurfaceComputerWorker;
}

/**
 * Starts Agent workers per Agent and computer workers per Computer Surface.
 * A Screen worker is bound to one Surface and runtime generation.
 */
export class Supervisor {
  #agentWorkers = new Map<AgentId, WorkerClient>();
  #computerWorkers = new Map<SurfaceId, ComputerWorkerEntry>();
  #restartTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  readonly #agentEnvironment: Record<string, string>;

  constructor(
    private readonly hooks: SupervisorHooks,
    private readonly workerDirs: { agents: string; computer: string },
  ) {
    this.#agentEnvironment = sanitizedEnv();
  }

  get agentsDir(): string {
    return this.workerDirs.agents;
  }

  async agentWorker(agentId: AgentId): Promise<WorkerClient> {
    let w = this.#agentWorkers.get(agentId);
    if (w?.alive) return w;
    if (w) await this.#killQuietly(w);
    w = new WorkerClient({
      name: `agent:${agentId}`,
      script: path.join(this.workerDirs.agents, agentId, "src", "worker.ts"),
      env: this.#agentEnvironment,
      onEvent: (e) => this.hooks.onAgentEvent(agentId, e),
      onRequest: (request, signal) =>
        this.hooks.onAgentComputerRequest(agentId, request, signal),
      onBotMessageRequest: (request, signal) =>
        this.hooks.onAgentBotMessageRequest(agentId, request, signal),
      onPluginRequest: (request, signal) =>
        this.hooks.onAgentPluginRequest(agentId, request, signal),
      onLocalRequest: (request, signal) =>
        this.hooks.onAgentLocalRequest(agentId, request, signal),
      onExit: (code) => {
        this.hooks.onWorkerCrash(
          agentId,
          new Error(`Agent worker exited (${code})`),
        );
        // Restart with backoff unless it was an explicit stop; sessions get recovered by callers.
        if (!this.#restartTimers.has(agentId)) {
          const t = setTimeout(() => {
            this.#restartTimers.delete(agentId);
            void this.agentWorker(agentId).catch((err) => this.hooks.onWorkerCrash(agentId, err));
          }, 1000);
          this.#restartTimers.set(agentId, t);
        }
      },
    });
    this.#agentWorkers.set(agentId, w);
    await w.start();
    return w;
  }

  async stopAgentWorker(agentId: AgentId): Promise<void> {
    const restart = this.#restartTimers.get(agentId);
    if (restart !== undefined) {
      clearTimeout(restart);
      this.#restartTimers.delete(agentId);
    }
    const worker = this.#agentWorkers.get(agentId);
    this.#agentWorkers.delete(agentId);
    if (worker !== undefined) await this.#killQuietly(worker);
  }

  async startComputerWorker(scope: ComputerWorkerScope): Promise<SurfaceComputerWorker> {
    if (!isSurfaceId(scope.surfaceId)) throw new Error("valid Computer Surface is required");
    if (!Number.isInteger(scope.runtimeGeneration) || scope.runtimeGeneration < 1) {
      throw new Error("valid runtime generation is required");
    }
    const existing = this.#computerWorkers.get(scope.surfaceId);
    if (existing?.runtimeGeneration === scope.runtimeGeneration && existing.client.alive) return existing.handle;
    if (existing !== undefined) {
      await this.stopComputerWorker(scope.surfaceId, existing.runtimeGeneration);
    }

    let entry: ComputerWorkerEntry;
    let reportExit: (error: Error) => void = () => {};
    const exited = new Promise<Error>((resolve) => {
      reportExit = resolve;
    });
    const workerEnvironment = {
      ...scope.env,
      OMARCHY_BOT_SURFACE_ID: scope.surfaceId,
      OMARCHY_BOT_RUNTIME_GENERATION: String(scope.runtimeGeneration),
    };
    const wrappedCommand = scope.wrapCommand?.(workerEnvironment);
    const client = new WorkerClient({
      name: `computer:${scope.surfaceId}:${scope.runtimeGeneration}`,
      script: path.join(this.workerDirs.computer, "src", "worker.ts"),
      env: wrappedCommand?.launcherEnvironment ?? workerEnvironment,
      ...(wrappedCommand === undefined ? {} : { commandPrefix: wrappedCommand.commandPrefix }),
      onEvent: () => {},
      onExit: (code) => {
        if (this.#computerWorkers.get(scope.surfaceId) === entry) {
          this.#computerWorkers.delete(scope.surfaceId);
        }
        reportExit(new Error(`Computer worker exited (${code})`));
      },
    });
    const handle: SurfaceComputerWorker = {
      surfaceId: scope.surfaceId,
      runtimeGeneration: scope.runtimeGeneration,
      exited,
      act: async (action, inputAuthority) => {
        if (this.#computerWorkers.get(scope.surfaceId) !== entry || !client.alive) {
          throw new Error("Computer worker context is no longer active");
        }
        return client.request({
          type: "act",
          surfaceId: scope.surfaceId,
          runtimeGeneration: scope.runtimeGeneration,
          action,
          ...(inputAuthority === undefined ? {} : { inputAuthority }),
        }, 30_000) as Promise<ComputerActPayload>;
      },
      stop: () => this.stopComputerWorker(scope.surfaceId, scope.runtimeGeneration),
    };
    entry = { runtimeGeneration: scope.runtimeGeneration, client, handle };
    this.#computerWorkers.set(scope.surfaceId, entry);
    try {
      await client.start();
      return handle;
    } catch (error) {
      if (this.#computerWorkers.get(scope.surfaceId) === entry) {
        this.#computerWorkers.delete(scope.surfaceId);
      }
      await this.#killQuietly(client);
      throw error;
    }
  }

  async stopComputerWorker(surfaceId: SurfaceId, runtimeGeneration: number): Promise<void> {
    const entry = this.#computerWorkers.get(surfaceId);
    if (entry === undefined || entry.runtimeGeneration !== runtimeGeneration) return;
    this.#computerWorkers.delete(surfaceId);
    await this.#killQuietly(entry.client);
  }

  async stopAll(): Promise<void> {
    for (const [, t] of this.#restartTimers) clearTimeout(t);
    this.#restartTimers.clear();
    const workers = [...this.#agentWorkers.values(), ...[...this.#computerWorkers.values()].map((entry) => entry.client)];
    this.#agentWorkers.clear();
    this.#computerWorkers.clear();
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }

  async #killQuietly(w: WorkerClient): Promise<void> {
    await w.stop().catch(() => {});
  }
}
