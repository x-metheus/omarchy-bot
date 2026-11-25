import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AgentEvent } from "@omarchy-bot/agent-contract";
import type { AgentId } from "@omarchy-bot/domain";
import type { AvatarRecipeDto, BotDto } from "@omarchy-bot/protocol";
import { HttpError, type BotsService } from "../bots/bots.ts";
import { resolveWorkCwd } from "../workspace/sharedWorkspace.ts";
import { AVATAR_RECIPE_SYSTEM_INSTRUCTIONS, parseAvatarRecipeResponse } from "./recipes.ts";

export const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_RECIPE_OUTPUT_BYTES = 32 * 1024;
const ALLOWED_UPLOAD_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
};
const ALLOWED_DECODED_FORMATS: Record<string, true> = {
  png: true,
  jpeg: true,
  webp: true,
};

interface AgentWorker {
  request(command: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

export interface AvatarSupervisor {
  agentWorker(agentId: AgentId): Promise<AgentWorker>;
}

interface PendingRecipe {
  agentId: AgentId;
  output: string;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bot avatar profile operations. Recipe generation uses an isolated temporary
 * Agent session and is intentionally absent from Thread persistence/history.
 */
export class AvatarService {
  #pendingRecipes = new Map<string, PendingRecipe>();
  readonly #timeoutMs: number;

  constructor(
    private readonly bots: BotsService,
    private readonly supervisor: AvatarSupervisor,
    private readonly avatarsDir: string,
    options: { timeoutMs?: number } = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(botId: string): Promise<BotDto> {
    const previousFile = this.bots.avatarFile(botId);
    const bot = this.bots.generateAvatarVariation(botId);
    if (previousFile !== undefined) await this.#removeLocalFile(previousFile);
    return bot;
  }

  async upload(botId: string, bytes: Uint8Array, contentType: string): Promise<BotDto> {
    this.bots.getDto(botId);
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (ALLOWED_UPLOAD_TYPES[mediaType] !== true) {
      throw new HttpError(400, "avatar must be a PNG, JPEG, or WebP image");
    }
    if (bytes.byteLength === 0) throw new HttpError(400, "avatar image is empty");
    if (bytes.byteLength > MAX_AVATAR_UPLOAD_BYTES) throw new HttpError(400, "avatar image exceeds 8MB");

    const relativeFile = `${botId}.png`;
    const destination = this.#localPath(relativeFile);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let normalized: Buffer;
    try {
      const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (metadata.format === undefined || ALLOWED_DECODED_FORMATS[metadata.format] !== true) {
        throw new Error("decoded image format is not supported");
      }
      normalized = await image
        .rotate()
        .resize(512, 512, { fit: "cover", withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
    } catch (error) {
      throw new HttpError(422, `avatar image could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await mkdir(this.avatarsDir, { recursive: true });
      await Bun.write(temporary, normalized);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new HttpError(500, `avatar image could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }

    return this.bots.setUploadedAvatar(botId, relativeFile);
  }

  async recipe(botId: string, prompt: string): Promise<BotDto> {
    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length === 0 || normalizedPrompt.length > 2000) {
      throw new HttpError(400, "avatar prompt must be between 1 and 2000 characters");
    }
    const agentId = this.bots.agentId(botId);
    const worker = await this.supervisor.agentWorker(agentId).catch((error: unknown) => {
      throw new HttpError(502, `avatar recipe agent is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    const operationId = randomUUID().replace(/-/g, "");
    let sessionId: string | undefined;

    try {
      const opened = await worker.request(
        {
          type: "session.open",
          botId,
          threadId: `avatar_profile_${operationId}`,
          options: { cwd: resolveWorkCwd(), instructions: AVATAR_RECIPE_SYSTEM_INSTRUCTIONS },
        },
        30_000,
      );
      if (
        opened === null ||
        typeof opened !== "object" ||
        !("sessionId" in opened) ||
        typeof opened.sessionId !== "string" ||
        opened.sessionId.length === 0
      ) {
        throw new Error("agent did not open an avatar recipe session");
      }
      sessionId = opened.sessionId;
      const stableSessionId = sessionId;

      const completion = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#settleRecipe(stableSessionId, new Error("avatar recipe agent timed out"));
        }, this.#timeoutMs);
        timer.unref?.();
        this.#pendingRecipes.set(stableSessionId, { agentId, output: "", resolve, reject, timer });
      });

      try {
        await worker.request(
          {
            type: "message.send",
            sessionId: stableSessionId,
            turnId: `avatar_${operationId}`,
            message: { text: normalizedPrompt },
          },
          30_000,
        );
      } catch (error) {
        this.#settleRecipe(stableSessionId, error instanceof Error ? error : new Error(String(error)));
        await completion.catch(() => {});
        throw error;
      }
      const output = await completion;

      let avatarRecipe: AvatarRecipeDto;
      try {
        avatarRecipe = parseAvatarRecipeResponse(output);
      } catch (error) {
        throw new HttpError(422, `invalid avatar recipe: ${error instanceof Error ? error.message : String(error)}`);
      }

      const previousFile = this.bots.avatarFile(botId);
      const bot = this.bots.setRecipeAvatar(botId, avatarRecipe);
      if (previousFile !== undefined) await this.#removeLocalFile(previousFile);
      return bot;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `avatar recipe agent failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (sessionId !== undefined) {
        this.#settleRecipe(sessionId, new Error("avatar recipe session closed"));
        await worker.request({ type: "session.close", sessionId }, 10_000).catch(() => {});
      }
    }
  }

  /** Returns true when an avatar recipe operation consumed the Agent event. */
  onAgentEvent(agentId: AgentId, event: AgentEvent): boolean {
    const sessionId = "sessionId" in event ? event.sessionId : undefined;
    if (sessionId === undefined) return false;
    const pending = this.#pendingRecipes.get(sessionId);
    if (pending === undefined || pending.agentId !== agentId) return false;

    switch (event.type) {
      case "response.delta":
        pending.output += event.text;
        if (Buffer.byteLength(pending.output, "utf8") > MAX_RECIPE_OUTPUT_BYTES) {
          this.#settleRecipe(sessionId, new Error("avatar recipe response is too large"));
        }
        return true;
      case "turn.completed":
        this.#settleRecipe(sessionId, undefined, pending.output);
        return true;
      case "turn.cancelled":
        this.#settleRecipe(sessionId, new Error("avatar recipe agent cancelled"));
        return true;
      case "error":
        this.#settleRecipe(sessionId, new Error(event.message));
        return true;
      default:
        return true;
    }
  }

  uploadPath(botId: string): string {
    const relativeFile = this.bots.avatarFile(botId);
    if (relativeFile === undefined) throw new HttpError(404, `bot ${botId} has no uploaded avatar`);
    return this.#localPath(relativeFile);
  }

  /** Permanent deletion uses a strict file operation so callers cannot report false success. */
  async deleteUploadedFile(relativeFile: string): Promise<void> {
    await rm(this.#localPath(relativeFile), { force: true });
  }

  #settleRecipe(sessionId: string, error?: Error, output?: string): void {
    const pending = this.#pendingRecipes.get(sessionId);
    if (pending === undefined) return;
    this.#pendingRecipes.delete(sessionId);
    clearTimeout(pending.timer);
    if (error !== undefined) pending.reject(error);
    else pending.resolve(output ?? pending.output);
  }

  #localPath(relativeFile: string): string {
    if (path.basename(relativeFile) !== relativeFile) throw new HttpError(500, "invalid stored avatar path");
    const root = path.resolve(this.avatarsDir);
    const fullPath = path.resolve(root, relativeFile);
    if (path.dirname(fullPath) !== root) throw new HttpError(500, "invalid stored avatar path");
    return fullPath;
  }

  async #removeLocalFile(relativeFile: string): Promise<void> {
    await rm(this.#localPath(relativeFile), { force: true }).catch(() => {});
  }
}
