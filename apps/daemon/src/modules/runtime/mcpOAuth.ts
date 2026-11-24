import { createHash } from "node:crypto";
import type { McpOAuthServerStore, McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type { SecretStore } from "./secrets.ts";

const secretPrefix = "mcp-oauth-";
const refreshQueues = new Map<string, Promise<void>>();

export function mcpOAuthSecretName(server: string): string {
  const digest = createHash("sha256").update(new URL(server).href).digest("hex");
  return secretPrefix + digest.slice(0, 64 - secretPrefix.length);
}

export class SecretMcpOAuthStateStore implements McpOAuthServerStore {
  readonly #secrets: SecretStore;
  readonly #server: string;
  readonly #name: string;
  readonly #description: string;

  constructor({ secrets, server }: { secrets: SecretStore; server: string }) {
    this.#secrets = secrets;
    this.#server = new URL(server).href;
    this.#name = mcpOAuthSecretName(this.#server);
    this.#description = `MCP OAuth state (${this.#name})`;
  }

  async load(): Promise<McpOAuthState | undefined> {
    const value = await this.#secrets.getAppSecretForRuntime(this.#name);
    if (value === undefined) return undefined;

    let state: unknown;
    try {
      state = JSON.parse(value);
    } catch {
      return undefined;
    }
    if (isStateForServer(state, this.#server)) return state;
  }

  save(state: McpOAuthState): Promise<void> {
    return this.#secrets.forApp().save(this.#name, this.#description, JSON.stringify(state));
  }

  // pi-mcp's browser step and provider refresh can write whole records outside this lock.
  // Sign-in orchestration must serialize sign-in against refresh for each server.
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = (refreshQueues.get(this.#server) ?? Promise.resolve()).then(fn);
    const finished = next.then(() => {}, () => {}).finally(() => {
      if (refreshQueues.get(this.#server) === finished) refreshQueues.delete(this.#server);
    });
    refreshQueues.set(this.#server, finished);
    return next;
  }
}

function isStateForServer(state: unknown, server: string): state is McpOAuthState {
  if (!isPlainObject(state) || !Object.hasOwn(state, "serverUrl") || state.serverUrl !== server) return false;

  const { clientInformation, discovery, tokens, codeVerifier, oauthState, tokensExpireAt } = state;
  return (clientInformation === undefined || isPlainObject(clientInformation))
    && (discovery === undefined || isPlainObject(discovery))
    && (tokens === undefined || isValidTokens(tokens))
    && (codeVerifier === undefined || isNonEmptyString(codeVerifier))
    && (oauthState === undefined || isNonEmptyString(oauthState))
    && (tokensExpireAt === undefined || Number.isFinite(tokensExpireAt));
}

function isValidTokens(tokens: unknown): boolean {
  return isPlainObject(tokens) && isNonEmptyString(tokens.access_token)
    && (tokens.refresh_token === undefined || typeof tokens.refresh_token === "string")
    && (tokens.scope === undefined || typeof tokens.scope === "string")
    && (tokens.token_type === undefined || typeof tokens.token_type === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
