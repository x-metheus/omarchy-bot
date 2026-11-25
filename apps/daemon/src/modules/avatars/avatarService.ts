import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BotDto } from "@omarchy-bot/protocol";
import { HttpError, type BotsService } from "../bots/bots.ts";

export const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;
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

export class AvatarService {
  constructor(
    private readonly bots: BotsService,
    private readonly avatarsDir: string,
  ) {}

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

  uploadPath(botId: string): string {
    const relativeFile = this.bots.avatarFile(botId);
    if (relativeFile === undefined) throw new HttpError(404, `bot ${botId} has no uploaded avatar`);
    return this.#localPath(relativeFile);
  }

  /** Permanent deletion uses a strict file operation so callers cannot report false success. */
  async deleteUploadedFile(relativeFile: string): Promise<void> {
    await rm(this.#localPath(relativeFile), { force: true });
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
