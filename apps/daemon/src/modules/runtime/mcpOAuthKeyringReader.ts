import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type SecretGet = (options: { service: string; name: string }) => Promise<string | null>;

export interface PiMcpAdapterTokenReader {
  read(serverName: string): Promise<unknown>;
}

// pi-mcp-adapter 2.33.0 mcp-auth.ts uses AUTH_SECRET_SERVICE and getAuthEntryAccount for keyring lookups.
export const PI_MCP_ADAPTER_OAUTH_SERVICE = "pi-mcp-adapter.oauth";

const CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked";
const MAX_CHUNKS = 64;
const MAX_CHUNK_CODE_UNITS = 1000;
const MAX_TOTAL_CODE_UNITS = MAX_CHUNKS * MAX_CHUNK_CODE_UNITS;
const MAX_ASSEMBLED_BYTES = 256 * 1024;

export function piMcpAdapterOAuthAccountName(serverName: string): string {
  return `sha256-${sha256(serverName)}`;
}

export class PiMcpAdapterKeyringUnavailableError extends Error {
  constructor() {
    super("The MCP OAuth adapter keyring is unavailable.");
    this.name = "PiMcpAdapterKeyringUnavailableError";
  }
}

export class PiMcpAdapterTokenEntryError extends Error {
  constructor() {
    super("The MCP OAuth adapter token entry is invalid.");
    this.name = "PiMcpAdapterTokenEntryError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseEntry(payload: string): Record<string, unknown> {
  let entry: unknown;
  try {
    entry = JSON.parse(payload);
  } catch {
    throw new PiMcpAdapterTokenEntryError();
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new PiMcpAdapterTokenEntryError();
  }
  return entry as Record<string, unknown>;
}

export function createPiMcpAdapterTokenReader({ get, timeoutMs = 2000, maxChunks = MAX_CHUNKS }: {
  get: SecretGet;
  timeoutMs?: number;
  maxChunks?: number;
}): PiMcpAdapterTokenReader {
  async function readSecret(name: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = get({ service: PI_MCP_ADAPTER_OAUTH_SERVICE, name });
      void reading.catch(() => {});
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(reject, timeoutMs);
      });
      return await Promise.race([reading, deadline]);
    } catch {
      throw new PiMcpAdapterKeyringUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read(serverName) {
      const account = piMcpAdapterOAuthAccountName(serverName);
      const value = await readSecret(account);
      if (value === null) return undefined;

      // pi-mcp-adapter/mcp-auth.ts writeSecureAuthEntryToStore stores compact JSON.stringify(AuthEntry).
      // Larger payloads use a manifest with the first 16 hex digits of the UTF-8 SHA-256 digest.
      // getAuthEntryChunkAccount's 0-based names hold slices of up to 1000 UTF-16 code units.
      const entry = parseEntry(value);
      if (!Object.hasOwn(entry, CHUNK_MANIFEST_KEY)) return entry;
      if (!Number.isInteger(maxChunks) || maxChunks < 0) throw new PiMcpAdapterTokenEntryError();
      const chunkLimit = Math.min(maxChunks, MAX_CHUNKS);
      const { chunkCount, chunkDigest } = entry;
      if (Object.keys(entry).length !== 3 || entry[CHUNK_MANIFEST_KEY] !== 1 ||
          typeof chunkCount !== "number" || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > chunkLimit ||
          typeof chunkDigest !== "string" || !/^[a-f0-9]{16}$/.test(chunkDigest)) {
        throw new PiMcpAdapterTokenEntryError();
      }

      const chunks: string[] = [];
      let totalCodeUnits = 0;
      for (let index = 0; index < chunkCount; index++) {
        if (totalCodeUnits + MAX_CHUNK_CODE_UNITS > MAX_TOTAL_CODE_UNITS) {
          throw new PiMcpAdapterTokenEntryError();
        }
        const chunk = await readSecret(`${account}.chunk.${chunkDigest}.${index}`);
        if (typeof chunk !== "string" || chunk.length > MAX_CHUNK_CODE_UNITS) {
          throw new PiMcpAdapterTokenEntryError();
        }
        totalCodeUnits += chunk.length;
        chunks.push(chunk);
      }

      // Measure UTF-8 and verify the digest on the joined payload because a slice can split a surrogate pair.
      const payload = chunks.join("");
      if (Buffer.byteLength(payload, "utf8") > MAX_ASSEMBLED_BYTES || sha256(payload).slice(0, 16) !== chunkDigest) {
        throw new PiMcpAdapterTokenEntryError();
      }
      return parseEntry(payload);
    },
  };
}
