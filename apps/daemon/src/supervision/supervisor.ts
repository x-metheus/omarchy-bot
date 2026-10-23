import path from "node:path";
import type {
  ToolChannelFrame,
  AgentEvent,

} from "@omarchy-bot/agent-contract";
import type { AgentId } from "@omarchy-bot/domain";
import { WorkerClient, sanitizedEnv } from "./workerClient.ts";

export interface SupervisorHooks {
  onAgentEvent: (agentId: AgentId, event: AgentEvent) => void;
  onWorkerCrash: (agentId: AgentId, error: Error) => void;
  onAgentToolFrame: (
    agentId: AgentId,
    frame: ToolChannelFrame,
  ) => Promise<ToolChannelFrame | undefined>;
}


/** Starts one Agent worker per Agent. */
export class Supervisor {
  #agentWorkers = new Map<AgentId, WorkerClient>();
  #restartTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  readonly #agentEnvironment: Record<string, string>;

  constructor(
    private readonly hooks: SupervisorHooks,
    private readonly workerDirs: { agents: string },
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
      onToolFrame: (frame) => this.hooks.onAgentToolFrame(agentId, frame),
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


  async stopAll(): Promise<void> {
    for (const [, t] of this.#restartTimers) clearTimeout(t);
    this.#restartTimers.clear();
    const workers = [...this.#agentWorkers.values()];
    this.#agentWorkers.clear();
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }

  async #killQuietly(w: WorkerClient): Promise<void> {
    await w.stop().catch(() => {});
  }
}
