import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AgentBotMessageToolContext,
  AgentBotMessageToolOutput,
} from "@omarchy-bot/agent-contract";
import { PEER_MAIL_TEXT_MAX_LENGTH, type AgentId } from "@omarchy-bot/domain";
import type { EventLog } from "../events/eventLog.ts";
import type { ThreadsService } from "../threads/threads.ts";
import type { AgentsRegistry } from "../agents/registry.ts";
import type { TurnService } from "../turns/turns.ts";

interface DeliveryRow {
  id: string;
  thread_id: string;
  message_id: string;
}

interface DispatchRow {
  id: string;
  source_bot_id: string | null;
  source_name: string;
  target_bot_id: string;
  thread_id: string;
  agent_id: AgentId;
  text: string;
}

interface DeliveryIdRow {
  id: string;
}

const MAX_CONCURRENT_DISPATCHES = 4;
const WORKER_ACCEPTANCE_FAILURE = "Target Agent could not accept this message.";
const RESTART_ACCEPTANCE_FAILURE =
  "Delivery acceptance could not be confirmed after daemon restart.";

interface BotIdentityRow {
  id: string;
  name: string;
}

/**
 * Durable asynchronous Bot-mail queue. Dispatch is requested only by durable
 * enqueue, Agent readiness, or daemon reconciliation.
 */
export class MailboxService {
  readonly #pendingDeliveryIds: string[] = [];
  readonly #pending = new Set<string>();
  readonly #active = new Set<string>();
  readonly #rerun = new Set<string>();
  #activeDispatches = 0;
  #nextPendingDelivery = 0;
  #drainScheduled = false;

  #stopping = false;
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly threads: ThreadsService,
    private readonly agents: AgentsRegistry,
    private readonly turns: TurnService,
  ) {
    this.agents.subscribe(({ agentId, to }) => {
      if (to === "ready") this.#scheduleAgentDispatch(agentId);
    });
  }

  pauseDispatch(): void {
    this.#stopping = true;
  }

  enqueue(
    context: AgentBotMessageToolContext,
    targetBotId: string,
    text: string,
  ): AgentBotMessageToolOutput {
    const existing = this.#delivery(context.turnId, context.toolCallId);
    if (existing !== undefined) return { deliveryId: existing.id, queued: true };

    if (typeof text !== "string" || text.trim().length === 0 || text.length > PEER_MAIL_TEXT_MAX_LENGTH) {
      throw new Error(`Bot message text must contain 1 to ${PEER_MAIL_TEXT_MAX_LENGTH} characters`);
    }
    if (typeof targetBotId !== "string" || !/^bot_[0-9a-f]{32}$/.test(targetBotId)) {
      throw new Error("target Bot ID is invalid");
    }
    if (targetBotId === context.botId) throw new Error("a Bot cannot send a message to itself");

    const deliveryId = `delivery_${randomUUID().replace(/-/g, "")}`;
    const threadId = randomUUID();
    const now = new Date().toISOString();

    const enqueue = this.db.transaction(() => {
      const duplicate = this.#delivery(context.turnId, context.toolCallId);
      if (duplicate !== undefined) return duplicate;

      const source = this.#bot(context.botId);
      if (source === undefined) throw new Error("source Bot no longer exists");
      if (this.#deleting(context.botId)) throw new Error("source Bot deletion is in progress");
      const target = this.#bot(targetBotId);
      if (target === undefined) throw new Error("target Bot does not exist");
      if (this.#deleting(targetBotId)) throw new Error("target Bot deletion is in progress");

      const preview = `From ${source.name}: ${text}`.replace(/\s+/g, " ").trim().slice(0, 120);
      this.threads.insertThreadRow(threadId, target.id, `From ${source.name}`.slice(0, 120));
      const message = this.threads.appendMessageQuiet(threadId, {
        author: { kind: "system" },
        kind: "text",
        text,
        peerMail: {
          deliveryId,
          sourceBotId: source.id,
          sourceName: source.name,
        },
      });
      this.db.query(
        `INSERT INTO bot_mail_deliveries (
           id, source_bot_id, source_turn_id, source_tool_call_id, source_name,
           target_bot_id, thread_id, message_id, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        deliveryId,
        source.id,
        context.turnId,
        context.toolCallId,
        source.name,
        target.id,
        threadId,
        message.id,
        now,
        now,
      );
      this.db.query(
        `INSERT INTO bot_state (
           bot_id, last_activity_at, preview_text, preview_at, unread_count, unread_thread_id
         ) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           last_activity_at = excluded.last_activity_at,
           preview_text = excluded.preview_text,
           preview_at = excluded.preview_at,
           unread_count = bot_state.unread_count + 1,
           unread_thread_id = excluded.unread_thread_id`,
      ).run(target.id, now, preview, now, threadId);

      this.events.append("thread", threadId, "thread.created", {
        botId: target.id,
        threadId,
        deliveryId,
      });
      this.events.append("thread", threadId, "message.appended", message);
      this.events.append("bot", target.id, "bot.attention", {
        threadId,
        preview,
        at: now,
      });
      return { id: deliveryId, thread_id: threadId, message_id: message.id } satisfies DeliveryRow;
    });

    const delivery = enqueue();
    this.#scheduleDispatch(delivery.id);
    return { deliveryId: delivery.id, queued: true };
  }

  /**
   * Reconciles the only two interrupted claim shapes before startup probes can
   * make Agents ready. Existing target Turns are failed, never replayed.
   */
  reconcileStartup(): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.query(
        `UPDATE bot_mail_deliveries
         SET state = 'queued', failure_reason = NULL, updated_at = ?
         WHERE state = 'dispatching' AND target_turn_id IS NULL`,
      ).run(now);
      this.db.query(
        `UPDATE turns
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?),
             outcome_reason = ?
         WHERE id IN (
           SELECT target_turn_id
           FROM bot_mail_deliveries
           WHERE state IN ('queued', 'dispatching') AND target_turn_id IS NOT NULL
         )`,
      ).run(now, RESTART_ACCEPTANCE_FAILURE);
      this.db.query(
        `UPDATE bot_mail_deliveries
         SET state = 'failed', failure_reason = ?, updated_at = ?
         WHERE state IN ('queued', 'dispatching') AND target_turn_id IS NOT NULL`,
      ).run(RESTART_ACCEPTANCE_FAILURE, now);
    })();

    this.#scheduleAllQueued();
  }

  #scheduleAllQueued(): void {
    const rows = this.db.query(
      `SELECT id FROM bot_mail_deliveries
       WHERE state = 'queued' AND target_turn_id IS NULL
       ORDER BY created_at, id`,
    ).all() as DeliveryIdRow[];
    for (const row of rows) this.#scheduleDispatch(row.id);
  }

  #scheduleAgentDispatch(agentId: AgentId): void {
    const rows = this.db.query(
      `SELECT deliveries.id
       FROM bot_mail_deliveries AS deliveries
       JOIN bots ON bots.id = deliveries.target_bot_id
       WHERE bots.agent_id = ?
         AND deliveries.state = 'queued'
         AND deliveries.target_turn_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM bot_deletions
           WHERE bot_id = deliveries.target_bot_id AND state = 'cleaning'
         )
       ORDER BY deliveries.created_at, deliveries.id`,
    ).all(agentId) as DeliveryIdRow[];
    for (const row of rows) this.#scheduleDispatch(row.id);
  }

  #scheduleDispatch(deliveryId: string): void {
    if (this.#active.has(deliveryId)) {
      this.#rerun.add(deliveryId);
      return;
    }
    if (this.#pending.has(deliveryId)) return;
    this.#pending.add(deliveryId);
    this.#pendingDeliveryIds.push(deliveryId);
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drainDispatches();
    });
  }

  #drainDispatches(): void {
    if (this.#stopping) return;
    while (
      this.#activeDispatches < MAX_CONCURRENT_DISPATCHES
      && this.#nextPendingDelivery < this.#pendingDeliveryIds.length
    ) {
      const deliveryId = this.#pendingDeliveryIds[this.#nextPendingDelivery++]!;
      this.#pending.delete(deliveryId);
      this.#active.add(deliveryId);
      this.#activeDispatches += 1;
      void this.#dispatch(deliveryId)
        .catch((error: unknown) => {
          console.error(`mailbox dispatch ${deliveryId} failed before a safe delivery transition`, error);
        })
        .finally(() => {
          this.#active.delete(deliveryId);
          this.#activeDispatches -= 1;
          if (this.#rerun.delete(deliveryId)) this.#scheduleDispatch(deliveryId);
          this.#drainDispatches();
        });
    }
    if (this.#nextPendingDelivery === this.#pendingDeliveryIds.length) {
      this.#pendingDeliveryIds.length = 0;
      this.#nextPendingDelivery = 0;
    }
  }

  async #dispatch(deliveryId: string): Promise<void> {
    const queued = this.#dispatchRow(deliveryId);
    if (queued === undefined || !this.agents.isReady(queued.agent_id)) return;

    const turnId = `turn_${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const claim = this.db.transaction(() => {
      const claimed = this.db.query(
        `UPDATE bot_mail_deliveries
         SET state = 'dispatching', updated_at = ?
         WHERE id = ? AND state = 'queued' AND target_turn_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM bot_deletions
             WHERE bot_id = bot_mail_deliveries.target_bot_id AND state = 'cleaning'
           )`,
      ).run(now, queued.id);
      if (claimed.changes !== 1) return false;
      this.threads.insertTurnRow({
        id: turnId,
        threadId: queued.thread_id,
        botId: queued.target_bot_id,
        nativeSessionId: "",
      });
      this.db.query(
        `UPDATE bot_mail_deliveries SET target_turn_id = ?, updated_at = ? WHERE id = ?`,
      ).run(turnId, now, queued.id);
      return true;
    });
    if (!claim()) return;

    const source = queued.source_bot_id === null
      ? queued.source_name
      : `${queued.source_name} (${queued.source_bot_id})`;
    const envelope = `Message from Bot ${source}:\n\n${queued.text}`;
    try {
      await this.turns.startPeerMailTurn({
        turnId,
        threadId: queued.thread_id,
        botId: queued.target_bot_id,
        agentId: queued.agent_id,
        envelope,
        acceptanceFailureReason: WORKER_ACCEPTANCE_FAILURE,
      });
      this.db.query(
        `UPDATE bot_mail_deliveries
         SET state = 'delivered', failure_reason = NULL, updated_at = ?
         WHERE id = ? AND state = 'dispatching' AND target_turn_id = ?`,
      ).run(new Date().toISOString(), queued.id, turnId);
    } catch {
      this.db.query(
        `UPDATE bot_mail_deliveries
         SET state = 'failed', failure_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'dispatching' AND target_turn_id = ?`,
      ).run(WORKER_ACCEPTANCE_FAILURE, new Date().toISOString(), queued.id, turnId);
    }
  }

  #dispatchRow(deliveryId: string): DispatchRow | undefined {
    const row = this.db.query(
      `SELECT deliveries.id,
              deliveries.source_bot_id,
              deliveries.source_name,
              deliveries.target_bot_id,
              deliveries.thread_id,
              bots.agent_id,
              messages.text
       FROM bot_mail_deliveries AS deliveries
       JOIN bots ON bots.id = deliveries.target_bot_id
       JOIN messages ON messages.id = deliveries.message_id
       WHERE deliveries.id = ?
         AND deliveries.state = 'queued'
         AND deliveries.target_turn_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM bot_deletions
           WHERE bot_id = deliveries.target_bot_id AND state = 'cleaning'
         )`,
    ).get(deliveryId) as DispatchRow | null;
    return row ?? undefined;
  }

  #delivery(turnId: string, toolCallId: string): DeliveryRow | undefined {
    const row = this.db.query(
      `SELECT id, thread_id, message_id
       FROM bot_mail_deliveries
       WHERE source_turn_id = ? AND source_tool_call_id = ?`,
    ).get(turnId, toolCallId) as DeliveryRow | null;
    return row ?? undefined;
  }

  #bot(botId: string): BotIdentityRow | undefined {
    const row = this.db.query(`SELECT id, name FROM bots WHERE id = ?`).get(botId) as BotIdentityRow | null;
    return row ?? undefined;
  }

  #deleting(botId: string): boolean {
    return this.db.query(
      `SELECT bot_id FROM bot_deletions WHERE bot_id = ? AND state = 'cleaning'`,
    ).get(botId) !== null;
  }
}
