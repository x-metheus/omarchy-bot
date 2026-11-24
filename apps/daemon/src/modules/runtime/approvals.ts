import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ApprovalAnswerBodyDto, ApprovalDto, ApprovalStatus } from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import { addSettingsAllowedFolder } from "../workspace/allowedFolders.ts";

/** An unanswered request expires after 7 days and the tool returns "no answer" to the Bot. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ApprovalRow = {
  id: string; thread_id: string; bot_id: string; turn_id: string | null; tool: ApprovalDto["tool"]; path: string; folder: string;
  status: ApprovalStatus; created_at: string; expires_at: string; answered_at: string | null;
};

export type ApprovalRequest = {
  taskId: number; callId: string; conversationId: number; threadId: string; botId: string;
  tool: ApprovalDto["tool"]; path: string; folder: string;
};

const ANSWER_STATUS = { allow_once: "allowed_once", allow_folder: "allowed_folder", deny: "denied" } as const;

function toDto(row: ApprovalRow): ApprovalDto {
  return {
    id: row.id, threadId: row.thread_id, botId: row.bot_id, turnId: row.turn_id, tool: row.tool, path: row.path, folder: row.folder,
    status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, answeredAt: row.answered_at,
  };
}

/** Approval records in Service storage. Durable tool tasks find their request by pi task id after a restart. */
export class ApprovalStore {
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly db: Database,
    private readonly events: Pick<EventLog, "append">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Find the task's request, or record a new pending one. */
  request(input: ApprovalRequest): ApprovalDto {
    const created = new Date(this.now());
    const turn = this.db.query<{ id: string }, [string, string]>(
      "SELECT id FROM turns WHERE thread_id = ? AND bot_id = ? AND status NOT IN ('completed', 'cancelled', 'failed') ORDER BY started_at DESC LIMIT 1",
    ).get(input.threadId, input.botId);
    const inserted = this.db.query(
      `INSERT OR IGNORE INTO approvals (id, task_id, call_id, conversation_id, thread_id, bot_id, turn_id, tool, path, folder, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.taskId, input.callId, input.conversationId, input.threadId, input.botId, turn?.id ?? null, input.tool, input.path, input.folder,
      created.toISOString(), new Date(created.getTime() + APPROVAL_TTL_MS).toISOString());
    const row = this.db.query<ApprovalRow & { call_id: string; tool: string }, [number]>("SELECT * FROM approvals WHERE task_id = ?").get(input.taskId);
    if (!row) throw new Error("approval request was not recorded");
    // A replayed task must ask about the same call and path, or its recorded intent changed under it.
    if (row.call_id !== input.callId || row.tool !== input.tool || row.path !== input.path) throw new Error("approval request does not match its tool call");
    const dto = toDto(row);
    if (inserted.changes > 0) this.events.append("thread", dto.threadId, "approval.requested", dto);
    return dto;
  }

  get(id: string): ApprovalDto | undefined {
    const row = this.db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? toDto(row) : undefined;
  }

  /** Pending requests that have not expired, oldest first. */
  listPending(filter: { threadId?: string } = {}): ApprovalDto[] {
    const now = new Date(this.now()).toISOString();
    const rows = filter.threadId === undefined
      ? this.db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at, id").all(now)
      : this.db.query<ApprovalRow, [string, string]>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? AND thread_id = ? ORDER BY created_at, id").all(now, filter.threadId);
    return rows.map(toDto);
  }

  hasPending(threadId: string, botId: string): boolean {
    return this.db.query("SELECT 1 FROM approvals WHERE thread_id = ? AND bot_id = ? AND status = 'pending'").get(threadId, botId) !== null;
  }

  answer(id: string, answer: ApprovalAnswerBodyDto["answer"]): ApprovalDto {
    const current = this.get(id);
    if (!current) throw new HttpError(404, "approval not found");
    if (current.status === "pending" && Date.parse(current.expiresAt) <= this.now()) this.expire(id);
    const status = ANSWER_STATUS[answer];
    const answered = this.db.transaction(() => {
      const changed = this.#settle(id, status);
      if (changed && status === "allowed_folder") addSettingsAllowedFolder(this.db, current.folder);
      return changed;
    })();
    if (!answered) throw new HttpError(409, `approval is already ${this.get(id)?.status ?? "gone"}`);
    return this.#announce(id);
  }

  /** Mark a pending request expired; true when this call expired it. */
  expire(id: string): boolean {
    if (!this.#settle(id, "expired")) return false;
    this.#announce(id);
    return true;
  }

  /** Withdraw the task's pending request after its tool call ended without an answer. */
  cancelTask(taskId: number): void {
    const row = this.db.query<{ id: string }, [number]>("SELECT id FROM approvals WHERE task_id = ? AND status = 'pending'").get(taskId);
    if (row && this.#settle(row.id, "cancelled")) this.#announce(row.id);
  }

  /**
   * Wait until the request is answered, expires, or `signal` aborts. The record is checked on every wake, so a missed
   * notification costs at most `recheckMs`.
   */
  async waitForAnswer(id: string, signal: AbortSignal | undefined, recheckMs = 60_000): Promise<ApprovalDto> {
    for (;;) {
      signal?.throwIfAborted();
      const current = this.get(id);
      if (!current) throw new Error("approval request was removed");
      if (current.status !== "pending") return current;
      const remaining = Date.parse(current.expiresAt) - this.now();
      if (remaining <= 0) {
        this.expire(id);
        continue;
      }
      await this.#wake(id, Math.min(remaining, recheckMs), signal);
    }
  }

  #settle(id: string, status: Exclude<ApprovalStatus, "pending">): boolean {
    return this.db.query("UPDATE approvals SET status = ?, answered_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date(this.now()).toISOString(), id).changes > 0;
  }

  #announce(id: string): ApprovalDto {
    const dto = this.get(id)!;
    this.events.append("thread", dto.threadId, "approval.resolved", dto);
    for (const wake of this.#waiters.get(id) ?? []) wake();
    return dto;
  }

  #wake(id: string, delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? new Set<() => void>();
      this.#waiters.set(id, waiters);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        waiters.delete(done);
        if (waiters.size === 0 && this.#waiters.get(id) === waiters) this.#waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
