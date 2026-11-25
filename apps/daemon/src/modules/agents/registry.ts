import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { AGENT_IDS, type AgentId, type AgentStatus } from "@omarchy-bot/domain";
import type { AgentDto } from "@omarchy-bot/protocol";
import type { AgentCapabilityInventory } from "@omarchy-bot/agent-contract";
import type { EventLog } from "../events/eventLog.ts";

const DISPLAY_NAMES: Record<AgentId, string> = {
  pi: "Pi", omp: "OMP", codex: "Codex", claude: "Claude", grok: "Grok",
  opencode: "OpenCode", gemini: "Gemini", copilot: "Copilot", crush: "Crush",
};

const MISSING_REASON = "adapter not installed in this build";

interface AgentRow { id: string; display_name: string; agent_version: string; status: string; reason: string | null; updated_at: string }

export interface AgentStatusTransition {
  agentId: AgentId;
  from: AgentStatus;
  to: AgentStatus;
}

export type AgentStatusTransitionListener = (transition: AgentStatusTransition) => void;

/** Retains Agent identities and status for existing Bots and API clients. */
export class AgentsRegistry {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly cfg: { conformanceDir: string },
  ) {}

  readonly #listeners = new Set<AgentStatusTransitionListener>();

  init(): void {
    const now = new Date().toISOString();
    for (const id of AGENT_IDS) {
      const existing = this.db.query(`SELECT id FROM agents WHERE id = ?`).get(id);
      if (existing) continue;
      this.db
        .query(`INSERT INTO agents (id, display_name, updated_at) VALUES (?, ?, ?)`)
        .run(id, DISPLAY_NAMES[id], now);
    }
    for (const id of AGENT_IDS) {
      this.#markMissing(id);
    }
  }

  subscribe(listener: AgentStatusTransitionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #row(id: string): AgentRow {
    return this.db.query(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow;
  }

  #markMissing(id: AgentId): void {
    const row = this.#row(id);
    if (row.status !== "missing" || row.reason !== MISSING_REASON) {
      this.#setStatus(id, "missing", MISSING_REASON);
    }
  }

  #setStatus(id: AgentId, status: AgentStatus, reason?: string): void {
    const previous = this.status(id);
    this.db
      .query(`UPDATE agents SET status = ?, reason = ?, updated_at = ? WHERE id = ?`)
      .run(status, reason ?? null, new Date().toISOString(), id);
    this.events.append("agent", id, "agent.status", { agentId: id, status, ...(reason !== undefined ? { reason } : {}) });
    if (previous !== status) {
      const transition = { agentId: id, from: previous, to: status };
      for (const listener of this.#listeners) listener(transition);
    }
  }

  toDto(row: AgentRow): AgentDto {
    const id = row.id as AgentId;
    const status = row.status as AgentStatus;
    const guidance = this.guidance(id, status);
    return {
      id,
      displayName: row.display_name,
      version: row.agent_version,
      status,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      ...(guidance !== undefined ? { guidance } : {}),
    };
  }

  /** Plain-language setup guidance for the creation Sheet when not ready. */
  guidance(id: AgentId, status: AgentStatus): string | undefined {
    switch (status) {
      case "ready":
      case "checking":
        return undefined;
      case "missing":
        return `${DISPLAY_NAMES[id]} is not available: no adapter is installed in this Omarchy Bot build yet.`;
      case "unconfigured":
        return `${DISPLAY_NAMES[id]} is installed but has not passed conformance for its current version.`;
      case "incompatible":
        return `${DISPLAY_NAMES[id]} failed its readiness probe. Check the agent's own setup (login/auth) and recheck.`;
      case "offline":
        return `${DISPLAY_NAMES[id]} did not respond. Restart the daemon or check the worker logs.`;
    }
  }

  list(): AgentDto[] {
    const rows = this.db.query(`SELECT * FROM agents ORDER BY id ASC`).all() as AgentRow[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: AgentId): AgentDto | undefined {
    const r = this.db.query(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
    return r ? this.toDto(r) : undefined;
  }

  status(id: AgentId): AgentStatus {
    return (this.#row(id).status ?? "missing") as AgentStatus;
  }

  isReady(id: AgentId): boolean {
    return this.status(id) === "ready";
  }

  markOffline(id: AgentId, reason: string): void {
    this.#setStatus(id, "offline", reason);
  }

  capabilityInventory(_id: AgentId): AgentCapabilityInventory | undefined {
    return undefined;
  }

  conformanceRecord(agentId: string, version: string): { ok: boolean; reason?: string } | undefined {
    const file = path.join(this.cfg.conformanceDir, `${agentId}-${version}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  async recheck(id: AgentId): Promise<AgentDto> {
    this.#markMissing(id);
    return this.get(id)!;
  }
}
