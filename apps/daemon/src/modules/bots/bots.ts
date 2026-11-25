import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentId, SurfaceId } from "@omarchy-bot/domain";
import {
  AVATAR_RENDERER_ID,
  AVATAR_STYLE_IDS,
  DEFAULT_AVATAR_STYLE_ID,
  type AvatarDto,
  type AvatarRecipeDto,
  type BotDto,
  type BotViewDto,
  type BotUpdatedEventPayload,
  type PatchBotBodyDto,
  type ThinkingAvailabilityDto,
} from "@omarchy-bot/protocol";
import type { EventLog } from "../events/eventLog.ts";
import type { AgentsRegistry } from "../agents/registry.ts";
import type { ThreadsService } from "../threads/threads.ts";

interface BotRow {
  surface_id: string;
  id: string; name: string; instructions: string; agent_id: string; model: string | null;
  avatar_kind: string; avatar_recipe: string; avatar_file: string | null;
  pinned: number;
  show_tool_calls: number; show_thinking: number; max_turns: number | null;
  created_at: string; updated_at: string;
}
interface BotStateRow {
  bot_id: string; last_activity_at: string | null; preview_text: string | null; preview_at: string | null;
  unread_count: number; unread_thread_id: string | null;
}



/** A new Bot ships with a deterministic generated avatar recipe. */
export function defaultAvatarRecipe(botId: string): string {
  return JSON.stringify({ rendererVersion: AVATAR_RENDERER_ID, style: DEFAULT_AVATAR_STYLE_ID, seed: botId, options: {} });
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * User-created Bots. Each Bot references exactly one Agent; the reference is
 * immutable (ADR 0002). Binary activity is derived from all of the Bot's
 * nonterminal Turns and never from Agent Readiness.
 */
export class BotsService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly agents: AgentsRegistry,
    private readonly threads: ThreadsService,
  ) {}

  #row(id: string): BotRow | undefined {
    return this.db
      .query(`SELECT bots.*, bot_surfaces.surface_id FROM bots JOIN bot_surfaces ON bot_surfaces.bot_id = bots.id WHERE bots.id = ?`)
      .get(id) as BotRow | undefined;
  }

  #stateRow(botId: string): BotStateRow | undefined {
    return this.db.query(`SELECT * FROM bot_state WHERE bot_id = ?`).get(botId) as BotStateRow | undefined;
  }

  create(input: { name: string; instructions?: string | undefined; agentId: AgentId; maxTurns?: number | null | undefined }): BotDto {
    const readiness = this.agents.get(input.agentId);
    if (!readiness) throw new HttpError(400, `unknown agent '${input.agentId}'`);
    if (readiness.status !== "ready") {
      throw new HttpError(
        400,
        readiness.guidance ?? `agent '${input.agentId}' is not ready (${readiness.status})`,
        { agentStatus: readiness.status },
      );
    }
    const id = `bot_${randomUUID().replace(/-/g, "")}`;
    const surfaceId = `surf_${randomUUID().replace(/-/g, "")}` as SurfaceId;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .query(`INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at, max_turns, model) VALUES (?, ?, ?, ?, 'generated', ?, ?, ?, ?, NULL)`)
        .run(id, input.name, input.instructions ?? "", input.agentId, defaultAvatarRecipe(id), now, now, input.maxTurns ?? null);
      this.db.query(`INSERT INTO bot_state (bot_id) VALUES (?)`).run(id);
      this.db.query(`INSERT INTO bot_surfaces (surface_id, bot_id, transitioned_at) VALUES (?, ?, ?)`).run(surfaceId, id, now);
    });
    tx();
    this.events.append("bot", id, "bot.created", this.getDto(id));
    return this.getDto(id);
  }

  getDto(id: string): BotDto {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `unknown bot ${id}`);
    return this.#toDto(r);
  }

  #toDto(r: BotRow): BotDto {
    const avatar: AvatarDto =
      r.avatar_kind === "upload" && r.avatar_file
        ? { kind: "upload", url: `/api/bots/${r.id}/avatar` }
        : { kind: r.avatar_kind === "recipe" ? "recipe" : "generated", recipe: JSON.parse(r.avatar_recipe || defaultAvatarRecipe(r.id)) };
    return {
      id: r.id, surfaceId: r.surface_id as SurfaceId, name: r.name, instructions: r.instructions, agentId: r.agent_id as AgentId,
      model: r.model,
      avatar,
      pinned: Boolean(r.pinned),
      showToolCalls: Boolean(r.show_tool_calls),
      showThinking: Boolean(r.show_thinking),
      maxTurns: r.max_turns,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): BotViewDto[] {
    const rows = this.db
      .query(`SELECT bots.*, bot_surfaces.surface_id FROM bots JOIN bot_surfaces ON bot_surfaces.bot_id = bots.id`)
      .all() as BotRow[];
    const views = rows.map((r) => this.#toView(r));
    views.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned)
        || (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)
        || a.id.localeCompare(b.id),
    );
    return views;
  }

  #thinkingAvailability(r: BotRow): ThinkingAvailabilityDto {
    if (this.agents.capabilityInventory(r.agent_id as AgentId)?.thinking.supported === true) {
      return "supported";
    }

    return this.threads.hasRetainedThinkingForBot(r.id) ? "history" : "unavailable";
  }

  #toView(r: BotRow): BotViewDto {
    const st = this.#stateRow(r.id);
    const status: BotViewDto["status"] =
      this.threads.activeTurnForBot(r.id) === undefined ? "inactive" : "active";
    return {
      ...this.#toDto(r),
      status,
      thinkingAvailability: this.#thinkingAvailability(r),
      unreadCount: st?.unread_count ?? 0,
      ...(st?.unread_thread_id !== undefined && st.unread_thread_id !== null ? { unreadThreadId: st.unread_thread_id } : {}),
      ...(st?.preview_text !== undefined && st.preview_text !== null ? { previewText: st.preview_text } : {}),
      ...(st?.preview_at !== undefined && st.preview_at !== null ? { previewAt: st.preview_at } : {}),
      ...(st?.last_activity_at !== undefined && st.last_activity_at !== null ? { lastActivityAt: st.last_activity_at } : {}),
    };
  }


  getView(id: string): BotViewDto {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `unknown bot ${id}`);
    return this.#toView(r);
  }

  /** Agent reference is fixed: any attempt to change it is a 400. */
  patch(id: string, body: PatchBotBodyDto & { agentId?: unknown }): BotDto {
    if (!this.#row(id)) throw new HttpError(404, `unknown bot ${id}`);
    if (body.agentId !== undefined) throw new HttpError(400, "agent cannot change");
    this.db.query(`
      UPDATE bots
      SET name = COALESCE(?, name),
          instructions = COALESCE(?, instructions),
          show_tool_calls = COALESCE(?, show_tool_calls),
          show_thinking = COALESCE(?, show_thinking),
          max_turns = CASE WHEN ? THEN ? ELSE max_turns END,
          model = CASE WHEN ? THEN ? ELSE model END,
          updated_at = ?
      WHERE id = ?
    `).run(
      body.name ?? null,
      body.instructions ?? null,
      body.showToolCalls === undefined ? null : body.showToolCalls ? 1 : 0,
      body.showThinking === undefined ? null : body.showThinking ? 1 : 0,
      body.maxTurns === undefined ? 0 : 1,
      body.maxTurns ?? null,
      body.model === undefined ? 0 : 1,
      body.model ?? null,
      new Date().toISOString(),
      id,
    );
    const updated = this.getDto(id);
    const payload: BotUpdatedEventPayload = {
      name: updated.name,
      instructions: updated.instructions,
      showToolCalls: updated.showToolCalls,
      showThinking: updated.showThinking,
      maxTurns: updated.maxTurns ?? null,
      model: updated.model,
    };
    this.events.append("bot", id, "bot.updated", payload);
    return updated;
  }


  /** Pinning changes navigation placement only; it never touches a Thread. */
  pin(id: string, pinned: boolean): BotDto {
    if (!this.#row(id)) throw new HttpError(404, `unknown bot ${id}`);
    this.db.query(`UPDATE bots SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id);
    const bot = this.getDto(id);
    this.events.append("bot", id, "bot.pinned", { pinned });
    return bot;
  }


  agentId(id: string): AgentId {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `unknown bot ${id}`);
    return r.agent_id as AgentId;
  }

  avatarFile(id: string): string | undefined {
    const r = this.#row(id);
    if (!r) throw new HttpError(404, `unknown bot ${id}`);
    return r.avatar_kind === "upload" ? r.avatar_file ?? undefined : undefined;
  }

  generateAvatarVariation(id: string): BotDto {
    this.getDto(id);
    const generated = this.db
      .query(`SELECT COUNT(*) AS count FROM events WHERE aggregate_type = 'bot' AND aggregate_id = ? AND type = 'bot.avatar_generated'`)
      .get(id) as { count: number };
    const variation = generated.count + 1;
    const recipe: AvatarRecipeDto = {
      rendererVersion: AVATAR_RENDERER_ID,
      style: AVATAR_STYLE_IDS[(variation - 1) % AVATAR_STYLE_IDS.length] ?? DEFAULT_AVATAR_STYLE_ID,
      seed: createHash("sha256").update(`${id}:${variation}`).digest("hex"),
      options: {},
    };
    this.#setAvatar(id, "generated", recipe, null);
    this.events.append("bot", id, "bot.avatar_generated", { avatar: this.getDto(id).avatar, variation });
    return this.getDto(id);
  }

  setRecipeAvatar(id: string, recipe: AvatarRecipeDto): BotDto {
    this.#setAvatar(id, "recipe", recipe, null);
    this.events.append("bot", id, "bot.avatar_recipe_updated", { avatar: this.getDto(id).avatar });
    return this.getDto(id);
  }

  setUploadedAvatar(id: string, relativeFile: string): BotDto {
    if (relativeFile !== `${id}.png`) throw new HttpError(400, "invalid local avatar file");
    this.#setAvatar(id, "upload", undefined, relativeFile);
    this.events.append("bot", id, "bot.avatar_uploaded", { avatar: this.getDto(id).avatar });
    return this.getDto(id);
  }

  #setAvatar(id: string, kind: "generated" | "recipe" | "upload", recipe: AvatarRecipeDto | undefined, avatarFile: string | null): void {
    if (!this.#row(id)) throw new HttpError(404, `unknown bot ${id}`);
    const now = new Date().toISOString();
    this.db
      .query(`UPDATE bots SET avatar_kind = ?, avatar_recipe = ?, avatar_file = ?, updated_at = ? WHERE id = ?`)
      .run(kind, recipe === undefined ? "" : JSON.stringify(recipe), avatarFile, now, id);
  }

  recordResponse(botId: string, threadId: string, text: string): void {
    const now = new Date().toISOString();
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
    this.db
      .query(`INSERT INTO bot_state (bot_id, last_activity_at, preview_text, preview_at, unread_count, unread_thread_id)
              VALUES (?, ?, ?, ?, 1, ?)
              ON CONFLICT(bot_id) DO UPDATE SET
                last_activity_at = excluded.last_activity_at,
                preview_text = excluded.preview_text,
                preview_at = excluded.preview_at,
                unread_count = bot_state.unread_count + 1,
                unread_thread_id = excluded.unread_thread_id`)
      .run(botId, now, preview, now, threadId);
    this.events.append("bot", botId, "bot.attention", { threadId, preview, at: now });
  }

  /** User input changes recency without replacing the latest Agent output. */
  recordUserMessage(botId: string, threadId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(`INSERT INTO bot_state (bot_id, last_activity_at)
              VALUES (?, ?)
              ON CONFLICT(bot_id) DO UPDATE SET
                last_activity_at = excluded.last_activity_at`)
      .run(botId, now);
    this.events.append("bot", botId, "bot.attention", { threadId, at: now });
  }


  clearUnread(botId: string, threadId: string): BotViewDto {
    this.getView(botId);
    this.db.query(`UPDATE bot_state SET unread_count = 0, unread_thread_id = NULL WHERE bot_id = ? AND unread_thread_id = ?`).run(botId, threadId);
    this.events.append("bot", botId, "bot.read", { threadId });
    return this.getView(botId);
  }

  unreadCount(botId: string): number {
    return this.#stateRow(botId)?.unread_count ?? 0;
  }
}
