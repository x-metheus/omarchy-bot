import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentCapabilityInventory, WorkerUserMessage } from "@omarchy-bot/agent-contract";
import type { AttachmentDto } from "@omarchy-bot/protocol";
import { confinedPath, type AgentId } from "@omarchy-bot/domain";
import { HttpError } from "../bots/bots.ts";

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface AttachmentRow {
  id: string;
  kind: "staged" | "managed";
  bot_id: string;
  thread_id: string | null;
  message_id: string | null;
  name: string;
  media_type: string;
  size: number;
  rel_path: string;
  source_sha256: string | null;
  draft_token: string | null;
  created_at: string;
}

export interface ManagedAttachmentFile {
  path: string;
  mediaType: string;
  size: number;
}

export interface AgentCapabilitySource {
  capabilityInventory(agentId: AgentId): AgentCapabilityInventory | undefined;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 32 && character !== "\n" && character !== "\r" && character !== "\t" && character !== "\f") return false;
  }
  return true;
}

/** Authoritative media type derived from content, never from a browser-provided filename or MIME type. */
export function sniffAttachmentMediaType(bytes: Uint8Array): string | undefined {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (!isUtf8Text(bytes)) return undefined;

  const text = new TextDecoder().decode(bytes).trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch {
      // Invalid JSON remains plain UTF-8 text; the bytes, not the extension, are authoritative.
    }
  }
  return "text/plain";
}

function assertAgentSupportsAttachment(
  agentId: AgentId,
  capabilities: AgentCapabilityInventory | undefined,
  attachment: Pick<AttachmentRow, "media_type" | "name" | "size">,
): void {
  if (capabilities === undefined) {
    throw new HttpError(400, `${agentId} has not reported attachment capabilities (${attachment.name})`);
  }

  const modality = attachment.media_type.startsWith("image/")
    ? "image"
    : attachment.media_type.startsWith("text/") || attachment.media_type === "application/json"
      ? "text"
      : undefined;
  if (modality === undefined || !capabilities.attachments[modality]) {
    throw new HttpError(400, `${agentId} cannot consume attachment media type ${attachment.media_type} (${attachment.name})`);
  }

  const maxTextBytes = capabilities.attachments.maxTextBytes;
  if (modality === "text" && maxTextBytes !== undefined && attachment.size > maxTextBytes) {
    const limit = maxTextBytes % 1024 === 0 ? `${maxTextBytes / 1024} KB` : `${maxTextBytes} bytes`;
    throw new HttpError(
      400,
      `${agentId} cannot consume attachment media type ${attachment.media_type} larger than ${limit} (${attachment.name})`,
    );
  }
}

/** Owns local staged copies and their one-way, immutable promotion into message history. */
export class AttachmentsService {
  readonly #stagedDir: string;
  readonly #managedDir: string;

  constructor(
    private readonly db: Database,
    private readonly attachmentsDir: string,
    private readonly agents: AgentCapabilitySource,
  ) {
    this.#stagedDir = path.join(attachmentsDir, "staged");
    this.#managedDir = path.join(attachmentsDir, "managed");
    mkdirSync(this.#stagedDir, { recursive: true });
    mkdirSync(this.#managedDir, { recursive: true });
  }

  async stage(botId: string, draftToken: string, file: File): Promise<AttachmentDto> {
    const bot = this.db.query("SELECT id, agent_id FROM bots WHERE id = ?").get(botId) as {
      id: string;
      agent_id: AgentId;
    } | null;
    if (!bot) throw new HttpError(404, `unknown bot ${botId}`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(400, "attachments must be 32 MB or smaller");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = sniffAttachmentMediaType(bytes);
    if (mediaType === undefined) throw new HttpError(400, "unsupported or invalid file content");
    const name = file.name.trim() || "attachment";
    assertAgentSupportsAttachment(bot.agent_id, this.agents.capabilityInventory(bot.agent_id), {
      media_type: mediaType,
      name,
      size: bytes.byteLength,
    });

    const id = `att_${randomUUID().replaceAll("-", "")}`;
    const relPath = path.join("staged", id);
    const target = path.join(this.attachmentsDir, relPath);
    await Bun.write(target, bytes);
    try {
      this.db.query(
        `INSERT INTO attachments (
           id, kind, bot_id, thread_id, message_id, name, media_type, size, rel_path, source_sha256, created_at, draft_token
         )
         VALUES (?, 'staged', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        botId,
        name,
        mediaType,
        bytes.byteLength,
        relPath,
        createHash("sha256").update(bytes).digest("hex"),
        new Date().toISOString(),
        draftToken,
      );
    } catch (error) {
      try { unlinkSync(target); } catch { /* the database error remains authoritative */ }
      throw error;
    }
    return { id, kind: "staged", name, mediaType, size: bytes.byteLength };
  }

  getStaged(id: string, draftToken: string): AttachmentDto | undefined {
    const row = this.#row(id);
    return row?.kind === "staged" && row.draft_token === draftToken ? this.#dto(row) : undefined;
  }

  deleteStaged(id: string, draftToken: string): boolean {
    const row = this.#row(id);
    if (row === undefined || row.kind !== "staged" || row.draft_token !== draftToken) return false;
    this.#deleteStagedRow(row);
    return true;
  }

  managedFile(id: string): ManagedAttachmentFile | undefined {
    const row = this.#row(id);
    if (row === undefined || row.kind !== "managed") return undefined;
    return { path: path.join(this.attachmentsDir, row.rel_path), mediaType: row.media_type, size: row.size };
  }

  /** Validate everything before atomically renaming files in the caller's SQLite send transaction. */
  promoteForMessage(input: {
    attachmentIds: readonly string[];
    botId: string;
    threadId: string;
    messageId: string;
    draftToken: string | undefined;
  }): NonNullable<WorkerUserMessage["attachments"]> {
    if (input.attachmentIds.length === 0) return [];
    const draftToken = input.draftToken;
    if (draftToken === undefined) throw new HttpError(400, "attachmentDraftToken is required");
    if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
      throw new HttpError(400, "attachmentIds must not contain duplicates");
    }

    const bot = this.db.query("SELECT agent_id FROM bots WHERE id = ?").get(input.botId) as {
      agent_id: AgentId;
    } | null;
    if (!bot) throw new HttpError(404, `unknown bot ${input.botId}`);
    const capabilities = this.agents.capabilityInventory(bot.agent_id);

    const rows = input.attachmentIds.map((id) => {
      const row = this.#row(id);
      if (
        row === undefined ||
        row.kind !== "staged" ||
        row.bot_id !== input.botId ||
        row.draft_token === null ||
        row.draft_token !== draftToken
      ) {
        throw new HttpError(400, `attachment ${id} is not staged for this draft`);
      }
      assertAgentSupportsAttachment(bot.agent_id, capabilities, row);
      return row;
    });

    const moved: Array<{ source: string; target: string }> = [];
    try {
      for (const row of rows) {
        const source = path.join(this.attachmentsDir, row.rel_path);
        const relPath = path.join("managed", row.id);
        const target = path.join(this.attachmentsDir, relPath);
        renameSync(source, target);
        moved.push({ source, target });
        const updated = this.db.query(
          `UPDATE attachments SET kind = 'managed', thread_id = ?, message_id = ?, rel_path = ?, draft_token = NULL
           WHERE id = ? AND kind = 'staged' AND bot_id = ? AND draft_token = ?`,
        ).run(input.threadId, input.messageId, relPath, row.id, input.botId, draftToken);
        if (updated.changes !== 1) throw new HttpError(400, `attachment ${row.id} is not staged for this draft`);
      }
    } catch (error) {
      for (const move of moved.reverse()) {
        try { renameSync(move.target, move.source); } catch { /* preserve the original promotion error */ }
      }
      throw error;
    }

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      path: path.join(this.#managedDir, row.id),
      mediaType: row.media_type,
    }));
  }

  /** Remove local bytes while retaining rows until the caller commits Bot deletion. */
  deleteOwnedFiles(botId: string): { removed: number; failures: Array<{ resource: string; message: string }> } {
    const rows = this.db.query(`SELECT * FROM attachments WHERE bot_id = ?`).all(botId) as AttachmentRow[];
    const failures: Array<{ resource: string; message: string }> = [];
    let removed = 0;
    const root = this.attachmentsDir;
    for (const row of rows) {
      try {
        let fullPath: string;
        try {
          fullPath = confinedPath(row.rel_path, root);
        } catch {
          throw new Error("stored attachment path escapes the managed root");
        }
        rmSync(fullPath, { force: true });
        removed += 1;
      } catch (error) {
        failures.push({
          resource: row.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { removed, failures };
  }

  gcStaged(maxAgeMs = STAGED_MAX_AGE_MS): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db.query("SELECT * FROM attachments WHERE kind = 'staged' AND created_at < ?").all(cutoff) as AttachmentRow[];
    for (const row of rows) this.#deleteStagedRow(row);
    return rows.length;
  }

  #deleteStagedRow(row: AttachmentRow): void {
    try { unlinkSync(path.join(this.attachmentsDir, row.rel_path)); } catch { /* deleting the row prevents stale ownership */ }
    this.db.query("DELETE FROM attachments WHERE id = ? AND kind = 'staged'").run(row.id);
  }

  #row(id: string): AttachmentRow | undefined {
    return this.db.query("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | null ?? undefined;
  }

  #dto(row: AttachmentRow): AttachmentDto {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      mediaType: row.media_type,
      size: row.size,
      ...(row.kind === "managed" ? { url: `/api/attachments/${row.id}` } : {}),
    };
  }
}
