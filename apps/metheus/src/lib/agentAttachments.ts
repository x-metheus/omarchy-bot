// Match the limits and formats of the Agent Daemon's attachment exchange.
export const maxAttachments = 8;
export const maxMessageBytes = 2 * 1024 * 1024;
const maxTextBytes = 64 * 1024;
const maxImageBytes = 1024 * 1024;
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const textExtensions = [".txt", ".md", ".csv", ".tsv", ".log", ".json", ".yaml", ".yml", ".xml"];
export const attachmentAccept = ["text/*", ...textExtensions, ...imageTypes].join(",");

export interface AgentAttachment {
  id: string;
  name: string;
  mediaType: string;
  available: boolean;
}

export type DraftAttachment = File | AgentAttachment;
export type AttachmentInput =
  | { type: "inline"; name: string; mediaType: string; content: string }
  | { type: "reference"; id: string };

export class AttachmentSelectionError extends Error {}

export function isAttachmentImage(mediaType: string): boolean {
  return imageTypes.includes(mediaType);
}

function imageContent(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onerror = reader.onabort = () => reject(reader.error);
  reader.onload = () => {
    const url = reader.result as string;
    resolve(url.slice(url.indexOf(",") + 1));
  };
  reader.readAsDataURL(file);
  return promise;
}

export async function prepareAttachment(attachment: DraftAttachment): Promise<AttachmentInput> {
  if (!(attachment instanceof File)) return { type: "reference", id: attachment.id };
  const { name, type, size } = attachment;
  if (!name.trim() || new TextEncoder().encode(name).length > 255 || /[\\/\p{Cc}]/u.test(name)) {
    throw new AttachmentSelectionError(`The filename “${name}” is not supported.`);
  }
  const isImage = isAttachmentImage(type);
  if (!isImage && !type.startsWith("text/") && !textExtensions.some(extension => name.toLowerCase().endsWith(extension))) {
    throw new AttachmentSelectionError(`“${name}” must be UTF-8 text or a PNG, JPEG, GIF, or WebP image.`);
  }
  if (size === 0 || size > (isImage ? maxImageBytes : maxTextBytes)) {
    throw new AttachmentSelectionError(`“${name}” must be nonempty and at most ${isImage ? "1 MiB" : "64 KiB"}.`);
  }
  const inaccessible = () => {
    throw new AttachmentSelectionError(`Could not open “${name}”. Select it again or remove it.`);
  };
  if (isImage) {
    const content = await imageContent(attachment).catch(inaccessible);
    return { type: "inline", name, mediaType: type, content };
  }
  const bytes = await attachment.arrayBuffer().catch(inaccessible);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AttachmentSelectionError(`“${name}” must contain valid UTF-8 text.`);
  }
  if (!content.trim() || content.includes("\0")) {
    throw new AttachmentSelectionError(`“${name}” must contain nonempty plain text.`);
  }
  return { type: "inline", name, mediaType: "text/plain", content };
}
