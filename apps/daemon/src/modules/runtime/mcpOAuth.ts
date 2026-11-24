import { createHash } from "node:crypto";
import type { McpOAuthServerStore, McpOAuthState, OAuthCallback } from "@earendil-works/pi-mcp/oauth";
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

export const MCP_OAUTH_CALLBACK_PATH = "/callback";

const oauthResponseErrorCodes = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "invalid_target",
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
  "session_selection_required",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
]);

/** The authorization server returned an error with an allowlisted or generic code. */
export class McpOAuthCallbackError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The authorization server rejected MCP sign-in.");
    this.name = "McpOAuthCallbackError";
    this.code = oauthResponseErrorCodes.has(code) ? code : "oauth_error";
  }
}

/** The listener closed because its wait for the browser redirect expired. */
export class McpOAuthCallbackTimeoutError extends Error {
  constructor() {
    super("The MCP sign-in callback timed out.");
    this.name = "McpOAuthCallbackTimeoutError";
  }
}

/** The wait for the browser redirect ended because of an abort or an explicit close. */
export class McpOAuthCallbackCancelledError extends Error {
  constructor() {
    super("The MCP sign-in callback was cancelled.");
    this.name = "McpOAuthCallbackCancelledError";
  }
}

export interface McpOAuthLoopbackCallback {
  readonly redirectUrl: string;
  readonly hostname: "127.0.0.1";
  readonly port: number;
  /** Register the listener's single waiter for a matching state. */
  waitForCallback(state: string, signal?: AbortSignal): Promise<OAuthCallback>;
  /** Stop the listener and cancel any pending wait. Safe to call repeatedly. */
  close(): Promise<void>;
}

export async function listenForMcpOAuthCallback({
  port = 0,
  path = MCP_OAUTH_CALLBACK_PATH,
  timeoutMs = 10 * 60_000,
}: { port?: number; path?: string; timeoutMs?: number } = {}): Promise<McpOAuthLoopbackCallback> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("Invalid MCP OAuth callback port.");
  // URL parsing can silently remove or rewrite these characters.
  if (!path.startsWith("/") || /[\x00-\x1f\x7f ?#\\]/.test(path)) {
    throw new TypeError("Invalid MCP OAuth callback path.");
  }

  const hostname = "127.0.0.1";
  const callbackPath = new URL(`http://${hostname}${path}`).pathname;
  if (callbackPath === "/") throw new TypeError("Invalid MCP OAuth callback path.");

  let waitingStarted = false;
  let pending: {
    state: string;
    resolve: (callback: OAuthCallback) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  } | undefined;
  let stopping: Promise<void> | undefined;

  const server = Bun.serve({
    hostname,
    port,
    development: false,
    fetch(request) {
      const url = URL.parse(request.url);
      if (!url) return callbackPage(400);
      if (url.pathname !== callbackPath) return callbackPage(404);
      if (waitingStarted && !pending) return callbackPage(410);
      if (request.method !== "GET") return callbackPage(405);

      const state = url.searchParams.get("state");
      const waiter = pending;
      if (!state || waiter?.state !== state) return callbackPage(400);
      takeWaiter();

      const error = url.searchParams.get("error");
      if (error !== null) {
        waiter.reject(new McpOAuthCallbackError(error));
        return callbackPage(400);
      }
      const code = url.searchParams.get("code");
      if (!code) {
        waiter.reject(new Error("The MCP sign-in callback did not include an authorization code."));
        return callbackPage(400);
      }
      const iss = url.searchParams.get("iss");
      waiter.resolve({ code, state, ...(iss ? { iss } : {}) });
      return callbackPage(200);
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) {
    await server.stop();
    throw new Error("The MCP OAuth callback listener did not bind to a TCP port.");
  }

  function takeWaiter() {
    const waiter = pending;
    pending = undefined;
    waiter?.cleanup();
    return waiter;
  }

  function close(): Promise<void> {
    takeWaiter()?.reject(new McpOAuthCallbackCancelledError());
    return stopping ??= server.stop();
  }

  return {
    hostname,
    port: boundPort,
    redirectUrl: `http://${hostname}:${boundPort}${callbackPath}`,
    waitForCallback(state, signal) {
      if (waitingStarted) return Promise.reject(new Error("The MCP OAuth callback listener can only be used once."));
      waitingStarted = true;
      if (stopping || signal?.aborted) {
        void close();
        return Promise.reject(new McpOAuthCallbackCancelledError());
      }

      const { promise, resolve, reject } = Promise.withResolvers<OAuthCallback>();
      const timer = setTimeout(() => {
        takeWaiter()?.reject(new McpOAuthCallbackTimeoutError());
        void close();
      }, timeoutMs).unref();
      const abort = () => { void close(); };
      pending = {
        state,
        resolve,
        reject,
        cleanup() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      return promise;
    },
    close,
  };
}

function callbackPage(status: number): Response {
  const message = status === 200 ? "Sign-in complete." : "Sign-in did not complete.";
  return new Response(`<!doctype html><html lang="en"><head><title>${message}</title></head><body><p>${message} You can close this window.</p></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      ...(status === 405 ? { allow: "GET" } : {}),
    },
  });
}
