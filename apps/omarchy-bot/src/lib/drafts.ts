export const DRAFT_STORAGE_VERSION = 1 as const;
export const DRAFT_STORAGE_PREFIX = `draft:v${DRAFT_STORAGE_VERSION}:`;

export interface ConversationDraft {
  text: string;
  /** Current Composer insertion point, clamped to the draft text. */
  cursor: number;
  stagedIds: string[];
  attachmentDraftToken?: string;
}

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function windowSessionStorage(): StorageLike | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function emptyDraft(): ConversationDraft {
  return { text: "", cursor: 0, stagedIds: [] };
}

function normalizePosition(value: unknown, textLength: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(textLength, Math.max(0, Math.trunc(value)));
}

function normalizeDraft(value: unknown): ConversationDraft | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== "string") return undefined;

  const text = candidate.text;
  const cursor = normalizePosition(candidate.cursor, text.length, text.length);
  const stagedIds = Array.isArray(candidate.stagedIds)
    ? [...new Set(candidate.stagedIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  const attachmentDraftToken = typeof candidate.attachmentDraftToken === "string" &&
      candidate.attachmentDraftToken.length <= 128 &&
      UUID_PATTERN.test(candidate.attachmentDraftToken)
    ? candidate.attachmentDraftToken
    : undefined;

  return {
    text,
    cursor,
    stagedIds,
    ...(attachmentDraftToken !== undefined ? { attachmentDraftToken } : {}),
  };
}

export function draftStorageKey(botId: string, threadId?: string | null): string {
  return `${DRAFT_STORAGE_PREFIX}${botId}:${threadId === undefined || threadId === null || threadId === "blank" ? "blank" : threadId}`;
}

/** Load one window-local draft. Legacy Foundation plain-text values migrate in place. */
export function loadDraft(
  botId: string,
  threadId?: string | null,
  storage: StorageLike | undefined = windowSessionStorage(),
): ConversationDraft {
  if (storage === undefined) return emptyDraft();
  const key = draftStorageKey(botId, threadId);

  try {
    const raw = storage.getItem(key);
    if (raw === null) return emptyDraft();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const migrated = { text: raw, cursor: raw.length, stagedIds: [] } satisfies ConversationDraft;
      storage.setItem(key, JSON.stringify(migrated));
      return migrated;
    }

    const draft = normalizeDraft(parsed);
    if (draft !== undefined) return draft;

    // Foundation stored raw text at this versioned key. Preserve JSON-shaped
    // user text as text rather than mistaking it for a corrupt object.
    const migrated = { text: raw, cursor: raw.length, stagedIds: [] } satisfies ConversationDraft;
    storage.setItem(key, JSON.stringify(migrated));
    return migrated;
  } catch {
    return emptyDraft();
  }
}

export function saveDraft(
  botId: string,
  threadId: string | null | undefined,
  draft: ConversationDraft,
  storage: StorageLike | undefined = windowSessionStorage(),
): void {
  if (storage === undefined) return;
  const key = draftStorageKey(botId, threadId);
  const normalized = normalizeDraft(draft) ?? emptyDraft();

  try {
    if (
      normalized.text === "" &&
      normalized.stagedIds.length === 0 &&
      normalized.attachmentDraftToken === undefined
    ) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(normalized));
    }
  } catch {
    // Quota and privacy-mode failures leave the controlled Composer state intact.
  }
}

export interface ClearedBotDrafts {
  entries: ReadonlyArray<{ key: string; value: string }>;
}

/**
 * Remove every draft owned by a Bot and retain the exact browser-local values
 * so a failed server-side deletion barrier can restore them.
 */
export function takeDraftsByBot(
  botId: string,
  storage: StorageLike | undefined = windowSessionStorage(),
): ClearedBotDrafts | undefined {
  if (storage === undefined) return { entries: [] };
  const prefix = `${DRAFT_STORAGE_PREFIX}${botId}:`;
  const entries: Array<{ key: string; value: string }> = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = storage.getItem(key);
      if (value !== null) entries.push({ key, value });
    }
    for (const entry of entries) storage.removeItem(entry.key);
    return { entries };
  } catch {
    try {
      for (const entry of entries) storage.setItem(entry.key, entry.value);
    } catch {
      // The caller reports that browser-local cleanup could not be verified.
    }
    return undefined;
  }
}

export function restoreDrafts(
  snapshot: ClearedBotDrafts,
  storage: StorageLike | undefined = windowSessionStorage(),
): boolean {
  if (storage === undefined) return snapshot.entries.length === 0;
  try {
    for (const entry of snapshot.entries) storage.setItem(entry.key, entry.value);
    return true;
  } catch {
    return false;
  }
}

/** Remove every draft owned by a Bot without touching similarly prefixed IDs. */
export function clearDraftsByBot(
  botId: string,
  storage: StorageLike | undefined = windowSessionStorage(),
): boolean {
  return takeDraftsByBot(botId, storage) !== undefined;
}
