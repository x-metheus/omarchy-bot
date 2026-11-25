import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { stderr, type AgentEvent } from "@omarchy-bot/agent-contract";
import type { AgentId } from "@omarchy-bot/domain";
import { WorkerClient, sanitizedEnv } from "./workerClient.ts";

export interface SupervisorHooks {
  onAgentEvent: (agentId: AgentId, event: AgentEvent) => void;
  onWorkerCrash: (agentId: AgentId, error: Error) => void;
}


export function preparePiAgentDirectory(directory: string): void {
  let entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry === undefined) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    entry = lstatSync(directory);
  }
  if (!entry.isDirectory()) throw new Error(`Pi agent directory ${directory} must be a real directory`);
  if (entry.uid !== process.geteuid?.() || (entry.mode & 0o7777) !== 0o700) {
    throw new Error(`Pi agent directory ${directory} must be owned by the Service and have mode 0700`);
  }
}

/** Starts one Agent worker per Agent. */
export class Supervisor {
  #agentWorkers = new Map<AgentId, WorkerClient>();
  #restartTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  readonly #agentEnvironment: Record<string, string>;

  constructor(
    private readonly hooks: SupervisorHooks,
    private readonly workerDirs: { agents: string; piAgentDir?: string },
  ) {
    this.#agentEnvironment = sanitizedEnv();
  }

  get agentsDir(): string {
    return this.workerDirs.agents;
  }

  async agentWorker(agentId: AgentId): Promise<WorkerClient> {
    let w = this.#agentWorkers.get(agentId);
    if (w?.alive) return w;
    // Replaces a dead generation only once its owned processes are gone; the
    // stop awaits an in-flight cleanup instead of repeating it.
    if (w) await this.#killQuietly(agentId, w);
    const piAgentDir = agentId === "pi" ? this.workerDirs.piAgentDir : undefined;
    if (piAgentDir !== undefined) preparePiAgentDirectory(piAgentDir);
    w = new WorkerClient({
      name: `agent:${agentId}`,
      script: path.join(this.workerDirs.agents, agentId, "src", "worker.ts"),
      env: piAgentDir !== undefined
        ? { ...this.#agentEnvironment, PI_CODING_AGENT_DIR: piAgentDir }
        : this.#agentEnvironment,
      onEvent: (e) => this.hooks.onAgentEvent(agentId, e),
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
    if (worker !== undefined) await this.#killQuietly(agentId, worker);
  }


  async stopAll(): Promise<void> {
    for (const [, t] of this.#restartTimers) clearTimeout(t);
    this.#restartTimers.clear();
    const workers = [...this.#agentWorkers.entries()];
    this.#agentWorkers.clear();
    // Shutdown attempts every worker and reports a failed teardown rather than
    // counting it as a clean stop.
    await Promise.all(
      workers.map(async ([agentId, worker]) => {
        try {
          await worker.stop();
        } catch (error) {
          stderr(`agent:${agentId} teardown failed: ${String(error)}`);
        }
      }),
    );
  }

  async #killQuietly(agentId: AgentId, w: WorkerClient): Promise<void> {
    // Quarantine and replacement paths must not fail the caller, but a failed
    // teardown still has to be visible rather than reported as a clean stop.
    await w.stop().catch((error: unknown) => {
      stderr(`agent:${agentId} worker teardown failed: ${String(error)}`);
    });
  }
}
