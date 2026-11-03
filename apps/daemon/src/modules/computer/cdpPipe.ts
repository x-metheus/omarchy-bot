import type { Readable, Writable } from "node:stream";

export interface CdpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CdpPipeLimits {
  /** Largest frame that is buffered and parsed; larger replies fail only their own request. */
  maxFrameBytes?: number;
  /** Largest frame the pipe will discard before giving up on the whole pipe. */
  hardFrameBytes?: number;
}

/** A reply that exceeded the frame limit; only its own request fails and the pipe stays usable. */
export class CdpReplyTooLargeError extends Error {
  constructor(readonly method: string, readonly limitBytes: number) {
    super(method.startsWith("Accessibility.")
      ? "page too large for a snapshot; narrow with read_text/wait_for or take a smaller snapshot"
      : `browser reply to ${method} too large; narrow with read_text/wait_for or take a smaller snapshot`);
    this.name = "CdpReplyTooLargeError";
  }
}

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HARD_FRAME_BYTES = 128 * 1024 * 1024;
/** Chromium serializes "id" (replies) or "method" (events) first; this prefix is enough to route a dropped frame. */
const FRAME_HEAD_BYTES = 256;

/** Chromium's private fd3 command/fd4 reply pipe; never opens a socket. */
export class CdpPipe {
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<Listener>();
  #chunks: Buffer[] = [];
  #bytes = 0;
  #error?: Error;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  /** Set while an oversized frame is being skipped up to its NUL terminator. */
  #discard: { bytes: number } | undefined;
  readonly #maxFrameBytes: number;
  readonly #hardFrameBytes: number;

  constructor(private readonly writable: Writable, private readonly readable: Readable, limits: CdpPipeLimits = {}) {
    this.#maxFrameBytes = limits.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.#hardFrameBytes = Math.max(limits.hardFrameBytes ?? HARD_FRAME_BYTES, this.#maxFrameBytes);
    writable.on("error", this.#onError);
    writable.on("close", this.#onEnd);
    readable.on("error", this.#onError);
    readable.on("end", this.#onEnd);
    readable.on("close", this.#onEnd);
    readable.on("data", this.#onData);
  }

  get alive(): boolean { return this.#error === undefined; }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown = {},
    sessionId?: string,
    options: CdpRequestOptions = {},
  ): Promise<T> {
    if (method === "Runtime.enable") return Promise.reject(new Error("Runtime.enable is forbidden for the Bot browser"));
    if (this.#error) return Promise.reject(this.#error);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("CDP deadline must be positive"));
    const id = ++this.#nextId;
    let frame: string;
    try {
      frame = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
      if (Buffer.byteLength(frame) > this.#maxFrameBytes) throw new Error("CDP frame exceeds byte limit");
    } catch (error) {
      return Promise.reject(error);
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const fail = (error: Error): void => {
      this.#pending.get(id)?.cleanup();
      this.#pending.delete(id);
      reject(error);
    };
    const onAbort = (): void => fail(abortError(options.signal!));
    const timer = setTimeout(() => fail(new Error(`CDP ${method} timed out`)), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    this.#pending.set(id, { method, resolve: (value) => resolve(value as T), reject, cleanup });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.writable.write(`${frame}\0`, (error) => { if (error) this.#fail(error); });
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  close(): void { this.#fail(new Error("CDP pipe closed")); }

  #onError = (error: Error): void => { this.#fail(error); };
  #onEnd = (): void => { this.#fail(new Error("CDP pipe reached EOF")); };
  #onData = (chunk: Buffer): void => {
    if (!this.alive) return;
    try {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(0, start);
        const part = chunk.subarray(start, end === -1 ? chunk.length : end);
        if (this.#discard) this.#discard.bytes += part.length;
        else if (this.#bytes + part.length > this.#maxFrameBytes) {
          // Stop buffering: keep only the routing prefix and skip the rest of this frame.
          const head = frameHead([...this.#chunks, part]);
          this.#discard = { bytes: this.#bytes + part.length };
          this.#chunks = [];
          this.#bytes = 0;
          this.#dropOversized(head);
        } else if (part.length) { this.#chunks.push(part); this.#bytes += part.length; }
        if (this.#discard && this.#discard.bytes > this.#hardFrameBytes) throw new Error("CDP frame exceeds hard byte limit");
        if (end === -1) return;
        if (this.#discard) this.#discard = undefined;
        else if (this.#bytes > 0) {
          const bytes = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#bytes);
          const message: unknown = JSON.parse(this.#decoder.decode(bytes));
          this.#chunks = [];
          this.#bytes = 0;
          this.#receive(message);
          if (!this.alive) return;
        }
        start = end + 1;
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** Settle only the request an oversized frame answers; unroutable frames still close the pipe. */
  #dropOversized(head: Buffer): void {
    const text = head.toString("latin1");
    const reply = /^\s*\{\s*"id"\s*:\s*(\d{1,15})\s*[,}]/.exec(text);
    if (reply) {
      const id = Number(reply[1]);
      const pending = this.#pending.get(id);
      if (!pending) return; // Late reply to a cancelled request.
      this.#pending.delete(id);
      pending.cleanup();
      pending.reject(new CdpReplyTooLargeError(pending.method, this.#maxFrameBytes));
      return;
    }
    // Oversized events (e.g. Accessibility.nodesUpdated) carry nothing the runtime needs.
    if (/^\s*\{\s*"method"\s*:\s*"[A-Za-z]+\.[A-Za-z]+"\s*,/.test(text)) return;
    throw new Error("CDP frame exceeds byte limit");
  }

  #receive(message: unknown): void {
    if (message === null || typeof message !== "object") throw new Error("Malformed CDP message");
    const record = message as Record<string, unknown>;
    if (typeof record.id === "number") {
      const pending = this.#pending.get(record.id);
      if (!pending) return; // Late replies to cancelled requests are harmless.
      this.#pending.delete(record.id);
      pending.cleanup();
      if (record.error) {
        const error = record.error as { message?: string };
        pending.reject(new Error(`CDP: ${error.message ?? "request failed"}`));
      } else pending.resolve(record.result ?? {});
    } else if (typeof record.method === "string") {
      const params = record.params !== null && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
      for (const listener of this.#listeners) listener(record.method, params, typeof record.sessionId === "string" ? record.sessionId : undefined);
    } else throw new Error("Malformed CDP message");
  }

  #fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    this.readable.off("data", this.#onData);
    this.readable.off("end", this.#onEnd);
    this.readable.off("close", this.#onEnd);
    this.writable.off("close", this.#onEnd);
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
    this.#listeners.clear();
    this.#chunks = [];
    this.#bytes = 0;
    this.#discard = undefined;
    this.writable.destroy();
    this.readable.destroy();
  }
}

function frameHead(parts: Buffer[]): Buffer {
  const head: Buffer[] = [];
  let length = 0;
  for (const part of parts) {
    if (length >= FRAME_HEAD_BYTES) break;
    const slice = part.subarray(0, FRAME_HEAD_BYTES - length);
    head.push(slice);
    length += slice.length;
  }
  return Buffer.concat(head, length);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser action aborted");
}
