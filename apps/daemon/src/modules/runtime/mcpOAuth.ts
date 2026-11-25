import { createHash } from "node:crypto";
import {
  completeMcpSignIn, createMcpAuthProvider, McpOAuthProvider, OAuthError, OAuthInsecureEndpointError, OAuthIssuerMismatchError,
  startMcpSignIn,
  type McpAuthProvider, type McpOAuthServerStore, type McpOAuthSettings, type McpOAuthState,
  type McpSignInOptions, type McpSignInRedirect, type OAuthCallback, type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import { parseMcpOAuthCallbackUrl } from "../plugins/nativeMcpOAuth.ts";
import type { SecretStore } from "./secrets.ts";

const secretPrefix = "mcp-oauth-";
const refreshQueues = new Map<string, Promise<void>>();

export function mcpOAuthSecretName(name: string, server: string): string {
  const digest = createHash("sha256").update(JSON.stringify([name, new URL(server).href])).digest("hex");
  return secretPrefix + digest.slice(0, 64 - secretPrefix.length);
}

export class SecretMcpOAuthStateStore implements McpOAuthServerStore {
  readonly #secrets: SecretStore;
  readonly #server: string;
  readonly #name: string;
  readonly #description: string;

  constructor({ secrets, name, server }: { secrets: SecretStore; name: string; server: string }) {
    this.#secrets = secrets;
    this.#server = new URL(server).href;
    this.#name = mcpOAuthSecretName(name, this.#server);
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

  // pi-mcp uses the same lock for refreshes and for the initial refresh during sign-in.
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = (refreshQueues.get(this.#name) ?? Promise.resolve()).then(fn);
    const finished = next.then(() => {}, () => {}).finally(() => {
      if (refreshQueues.get(this.#name) === finished) refreshQueues.delete(this.#name);
    });
    refreshQueues.set(this.#name, finished);
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
const DEFAULT_CALLBACK_TIMEOUT_MS = 10 * 60_000;
// URL parsing can silently remove or rewrite these characters.
const invalidCallbackCharacters = /[\x00-\x1f\x7f ?#\\]/;

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
  readonly expiresAt: number;
  /** Register the listener's single waiter for a matching state. */
  waitForCallback(state: string, signal?: AbortSignal): Promise<OAuthCallback>;
  /** Stop the listener and cancel any pending wait. Safe to call repeatedly. */
  close(): Promise<void>;
}

export async function listenForMcpOAuthCallback({
  port = 0,
  path = MCP_OAUTH_CALLBACK_PATH,
  timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
  now = Date.now,
  expiresAt = now() + timeoutMs,
}: { port?: number; path?: string; timeoutMs?: number; now?: () => number; expiresAt?: number } = {}): Promise<McpOAuthLoopbackCallback> {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("Invalid MCP OAuth callback port.");
  if (!path.startsWith("/") || invalidCallbackCharacters.test(path)) {
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
    expiresAt,
    redirectUrl: `http://${hostname}:${boundPort}${callbackPath}`,
    waitForCallback(state, signal) {
      if (waitingStarted) return Promise.reject(new Error("The MCP OAuth callback listener can only be used once."));
      waitingStarted = true;
      if (stopping || signal?.aborted) {
        void close();
        return Promise.reject(new McpOAuthCallbackCancelledError());
      }

      const { promise, resolve, reject } = Promise.withResolvers<OAuthCallback>();
      const waitMs = Math.max(0, expiresAt - now());
      const timer = setTimeout(() => {
        takeWaiter()?.reject(new McpOAuthCallbackTimeoutError());
        void close();
      }, waitMs).unref();
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

export type McpOAuthManagerDeps = {
  secrets: SecretStore;
  settings?: (connection: { name: string; serverUrl: string }) => McpOAuthSettings;
  clientName?: string;
  now?: () => number;
  onComplete?: (outcome: { name: string; authorizationId: string } & McpOAuthCompletionOutcome) =>
    Promise<McpOAuthCompletionOutcome | void> | McpOAuthCompletionOutcome | void;
};

type McpOAuthFailureReason = "auth_failed" | "connect_failed" | "expired";
type McpOAuthCompletionOutcome = { status: "completed" } | { status: "failed"; reason: McpOAuthFailureReason };
type CachedMcpAuthProvider = { url: string; provider: McpAuthProvider; challenge?: OAuthChallenge };
type McpOAuthStartInput = { name: string; serverUrl: string; authorizationId: string; expiresAt?: number };
type PendingMcpOAuthAttempt = {
  name: string;
  authorizationId: string;
  controller: AbortController;
  listener: Promise<McpOAuthLoopbackCallback>;
  deadline: number;
  signIn?: { options: McpSignInOptions; authorization: McpSignInRedirect };
  completion?: Promise<McpOAuthCompletionOutcome>;
};

export class McpOAuthManager {
  readonly #deps: McpOAuthManagerDeps;
  readonly #clientName: string;
  readonly #now: () => number;
  readonly #providers = new Map<string, CachedMcpAuthProvider>();
  readonly #pending = new Map<string, PendingMcpOAuthAttempt>();
  readonly #operations = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;

  constructor(deps: McpOAuthManagerDeps) {
    this.#deps = deps;
    this.#clientName = deps.clientName ?? "Omarchy Bot";
    this.#now = deps.now ?? Date.now;
  }

  authProvider(name: string, serverUrl: string): McpAuthProvider {
    if (this.#closing) throw new Error("The MCP OAuth manager is closed.");
    const url = new URL(serverUrl).href;
    const cached = this.#providers.get(name);
    if (cached?.url === url) return cached.provider;
    // Each connection owns its OAuth credentials and challenge, even when accounts share an endpoint.
    const provider = createMcpAuthProvider({
      serverUrl: url,
      store: new SecretMcpOAuthStateStore({ secrets: this.#deps.secrets, name, server: url }),
      settings: () => this.#deps.settings?.({ name, serverUrl: url }) ?? {},
      clientName: this.#clientName,
      onChallenge: (challenge) => { entry.challenge = challenge; },
    });
    const onUnauthorized = provider.onUnauthorized?.bind(provider);
    const trackedProvider: McpAuthProvider = {
      // A token request can still be reading the store when close starts, before a refresh is registered.
      token: () => this.#closing ? Promise.resolve(undefined) : this.#track(provider.token()),
      settled: () => provider.settled(),
      ...(onUnauthorized ? {
        onUnauthorized: (context) => this.#closing ? Promise.resolve() : this.#track(onUnauthorized(context)),
      } : {}),
    };
    const entry: CachedMcpAuthProvider = { url, provider: trackedProvider };
    this.#providers.set(name, entry);
    return trackedProvider;
  }

  start(input: McpOAuthStartInput): Promise<{ authorizationUrl: string } | { authorized: true }> {
    return this.#track(this.#start(input));
  }

  async #start({ name, serverUrl, authorizationId, expiresAt }: McpOAuthStartInput): Promise<{ authorizationUrl: string } | { authorized: true }> {
    if (this.#closing) throw new Error("The MCP OAuth manager is closed.");
    const previousClose = this.cancel({ name });
    let deadline: number;
    let url: string;
    let settings: McpOAuthSettings;
    let callbackBinding: ReturnType<typeof resolveCallbackBinding>;
    try {
      deadline = expiresAt ?? this.#now() + DEFAULT_CALLBACK_TIMEOUT_MS;
      url = new URL(serverUrl).href;
      settings = this.#deps.settings?.({ name, serverUrl: url }) ?? {};
      callbackBinding = resolveCallbackBinding(settings);
    } catch {
      await Promise.allSettled([previousClose]);
      void this.#reportOutcome(name, authorizationId, { status: "failed", reason: "auth_failed" });
      throw new Error("MCP sign-in could not be started.");
    }
    const controller = new AbortController();
    const { signal } = controller;
    const listener = previousClose.then(() => {
      signal.throwIfAborted();
      if (!Number.isFinite(deadline) || this.#now() >= deadline) throw new McpOAuthCallbackTimeoutError();
      return listenForMcpOAuthCallback({
        ...callbackBinding,
        expiresAt: deadline,
        now: this.#now,
      });
    });
    const attempt: PendingMcpOAuthAttempt = { name, authorizationId, controller, listener, deadline };
    this.#pending.set(name, attempt);
    let callback: McpOAuthLoopbackCallback | undefined;
    try {
      callback = await listener;
      signal.throwIfAborted();
      const store = new SecretMcpOAuthStateStore({ secrets: this.#deps.secrets, name, server: url });
      const cached = this.#providers.get(name);
      const challenge = cached?.url === url ? cached.challenge : undefined;
      const redirectUrl = callbackBinding.fixedRedirectUrl ?? (callbackBinding.redirectHostname
        ? `http://${callbackBinding.redirectHostname}:${callback.port}${callbackBinding.path}` : callback.redirectUrl);
      const options: McpSignInOptions = {
        serverUrl: url, store, settings, clientName: this.#clientName,
        redirectUrl, signal, ...(challenge ? { challenge } : {}),
      };
      let outcome: McpOAuthCompletionOutcome | undefined;
      const authorization = await startSignInUnderLock(options, async (authorized) => {
        if (this.#now() >= deadline) {
          if (authorized) await invalidateSignInTokens(options);
          throw new McpOAuthCallbackTimeoutError();
        }
        if (authorized) {
          outcome = await this.#finishAttempt(attempt, undefined, options);
          if (!outcome) signal.throwIfAborted();
        }
      });
      if (authorization.kind === "authorized") {
        if (outcome) void this.#reportAttemptOutcome(attempt, outcome);
        return { authorized: true };
      }
      signal.throwIfAborted();
      attempt.signIn = { options, authorization };
      void callback.waitForCallback(authorization.state, signal).then(
        (response) => this.#completeAttempt(attempt, response),
        (error: unknown) => this.#completeAttempt(attempt, error instanceof McpOAuthCallbackTimeoutError ? "expired" : "auth_failed"),
      ).catch(() => {});
      return { authorizationUrl: authorization.authorizationUrl };
    } catch (error) {
      const reason = callback || error instanceof McpOAuthCallbackTimeoutError ? failureReason(error) : "auth_failed";
      const outcome = await this.#finishAttempt(attempt, reason);
      if (outcome) void this.#reportAttemptOutcome(attempt, outcome);
      if (reason === "expired") throw new McpOAuthCallbackTimeoutError();
      throw new Error("MCP sign-in could not be started.");
    }
  }

  async complete({ name, redirectUrl }: { name: string; redirectUrl: string }): Promise<McpOAuthCompletionOutcome> {
    const attempt = this.#pending.get(name);
    if (!attempt?.signIn) throw new Error("No pending MCP sign-in.");
    const { authorization } = attempt.signIn;
    const url = URL.parse(redirectUrl);
    const expected = new URL(authorization.redirectUrl);
    const state = url?.searchParams.get("state");
    if (!url || url.origin !== expected.origin || url.pathname !== expected.pathname || state !== authorization.state) {
      throw new Error("The MCP sign-in redirect is invalid.");
    }
    const error = url.searchParams.get("error");
    if (error !== null) return this.#completeAttempt(attempt, "auth_failed");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("The MCP sign-in redirect is invalid.");
    const iss = url.searchParams.get("iss");
    return this.#completeAttempt(attempt, { code, state, ...(iss ? { iss } : {}) });
  }

  async cancel({ name, authorizationId }: { name: string; authorizationId?: string }): Promise<void> {
    const attempt = this.#pending.get(name);
    if (attempt && !attempt.controller.signal.aborted && (authorizationId === undefined || attempt.authorizationId === authorizationId)) {
      await this.#stopAttempt(attempt);
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      const shutdown = Promise.withResolvers<void>();
      this.#closing = shutdown.promise;
      shutdown.resolve(Promise.allSettled([
        ...[...this.#pending.values()].map((attempt) => this.#stopAttempt(attempt)),
        ...this.#operations,
      ]).then(async () => {
        await Promise.allSettled([...this.#providers.values()].map(({ provider }) => provider.settled()));
      }));
    }
    return this.#closing;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    return operation.finally(() => { this.#operations.delete(operation); });
  }

  #stopAttempt(attempt: PendingMcpOAuthAttempt): Promise<void> {
    if (this.#pending.get(attempt.name) === attempt) this.#pending.delete(attempt.name);
    attempt.controller.abort();
    return this.#track(attempt.listener.then((listener) => listener.close(), () => {}));
  }

  #completeAttempt(attempt: PendingMcpOAuthAttempt, response: OAuthCallback | McpOAuthFailureReason): Promise<McpOAuthCompletionOutcome> {
    // Outcome handlers can check the connection or call close() after credential work has drained.
    return attempt.completion ??= this.#track(this.#settleAttempt(attempt, response)).then(async (outcome): Promise<McpOAuthCompletionOutcome> => {
      if (!outcome) return { status: "failed", reason: "auth_failed" };
      return this.#reportAttemptOutcome(attempt, outcome);
    });
  }

  async #settleAttempt(attempt: PendingMcpOAuthAttempt, response: OAuthCallback | McpOAuthFailureReason): Promise<McpOAuthCompletionOutcome | undefined> {
    const { signIn, deadline, controller: { signal } } = attempt;
    if (!signIn || signal.aborted) return;
    if (typeof response === "string") return this.#finishAttempt(attempt, response);
    const { options, authorization } = signIn;
    try {
      // Hold the refresh lock through the final deadline check so a later sign-in cannot race credential cleanup.
      return await options.store.withRefreshLock(async () => {
        signal.throwIfAborted();
        if (this.#now() >= deadline) throw new McpOAuthCallbackTimeoutError();
        await completeMcpSignIn({ ...options, authorization, response });
        if (this.#now() >= deadline) await invalidateSignInTokens(options);
        return this.#finishAttempt(attempt, undefined, options);
      });
    } catch (error) {
      return this.#finishAttempt(attempt, failureReason(error));
    }
  }

  async #finishAttempt(attempt: PendingMcpOAuthAttempt, reason?: McpOAuthFailureReason, options?: McpSignInOptions): Promise<McpOAuthCompletionOutcome | undefined> {
    const { name, controller, deadline } = attempt;
    await attempt.listener.then((listener) => listener.close(), () => {});
    if (options && this.#now() >= deadline) await invalidateSignInTokens(options);
    // Cancelled, replaced, and shutdown attempts publish no outcome because the caller has abandoned them.
    if (controller.signal.aborted) return;
    controller.abort();
    const cached = this.#providers.get(name);
    if (cached && options?.challenge && cached.challenge === options.challenge) delete cached.challenge;
    return reason ? { status: "failed", reason } : { status: "completed" };
  }

  async #reportAttemptOutcome(attempt: PendingMcpOAuthAttempt, outcome: McpOAuthCompletionOutcome): Promise<McpOAuthCompletionOutcome> {
    const { name, authorizationId } = attempt;
    try {
      return await this.#reportOutcome(name, authorizationId, outcome);
    } finally {
      if (this.#pending.get(name) === attempt) this.#pending.delete(name);
    }
  }

  async #reportOutcome(name: string, authorizationId: string, outcome: McpOAuthCompletionOutcome): Promise<McpOAuthCompletionOutcome> {
    try { return await this.#deps.onComplete?.({ name, authorizationId, ...outcome }) ?? outcome; }
    catch { return outcome; }
  }
}

export function resolveCallbackBinding({ callbackUrl, callbackPort = 0 }: McpOAuthSettings):
  { port: number; path?: string; redirectHostname?: string; fixedRedirectUrl?: string } {
  if (callbackUrl === undefined) return { port: callbackPort };
  const parsed = parseMcpOAuthCallbackUrl(callbackUrl);
  if (!parsed) throw new Error("Invalid MCP OAuth callback URL.");
  return {
    port: parsed.port ?? callbackPort,
    path: parsed.url.pathname,
    redirectHostname: parsed.url.hostname,
    ...(parsed.port === undefined ? {} : { fixedRedirectUrl: callbackUrl }),
  };
}

function failureReason(error: unknown): McpOAuthFailureReason {
  if (error instanceof McpOAuthCallbackTimeoutError) return "expired";
  if (error instanceof OAuthError || error instanceof OAuthIssuerMismatchError || error instanceof OAuthInsecureEndpointError) return "auth_failed";
  return "connect_failed";
}

async function invalidateSignInTokens(options: McpSignInOptions): Promise<never> {
  // The transport provider refreshes tokens. The stateful OAuth provider invalidates them.
  const provider = new McpOAuthProvider({
    serverUrl: options.serverUrl, redirectUrl: options.redirectUrl, store: options.store,
    clientMetadata: {}, onRedirect: () => {},
  });
  try {
    const invalidated = provider.invalidateCredentials && await Promise.resolve()
      .then(() => provider.invalidateCredentials("tokens"))
      .then(() => true, () => false);
    if (!invalidated) await options.store.save({ serverUrl: options.serverUrl });
  } finally {
    throw new McpOAuthCallbackTimeoutError();
  }
}

function startSignInUnderLock(options: McpSignInOptions, checkDeadline: (authorized: boolean) => Promise<void>) {
  const { store } = options;
  return store.withRefreshLock(async () => {
    let refresh: Promise<unknown> | undefined;
    const lockedStore: McpOAuthServerStore = {
      load: () => store.load(),
      save: (state) => store.save(state),
      // startMcpSignIn locks the initial refresh itself. Hold the same lock through browser setup,
      // which also writes the PKCE state and credentials, and reuse it for that initial refresh.
      withRefreshLock<T>(run: () => Promise<T>) {
        const result = run();
        refresh = result;
        return result;
      },
    };
    try {
      await checkDeadline(false);
      const authorization = await startMcpSignIn({ ...options, store: lockedStore });
      await checkDeadline(authorization.kind === "authorized");
      return authorization;
    } finally {
      // A refresh can outlive an abort and must save rotated tokens before releasing the lock.
      await refresh?.catch(() => {});
    }
  });
}
