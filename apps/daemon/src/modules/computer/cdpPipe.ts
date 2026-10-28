import type { Readable, Writable } from "node:stream";

export interface CdpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type Listener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Chromium's private fd3 command/fd4 reply pipe; never opens a socket. */
export class CdpPipe {
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<Listener>();
  #chunks: Buffer[] = [];
  #bytes = 0;
  #error?: Error;
  #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly writable: Writable, private readonly readable: Readable) {
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
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("CDP frame exceeds byte limit");
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
    this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
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
        if (this.#bytes + part.length > MAX_FRAME_BYTES) throw new Error("CDP frame exceeds byte limit");
        if (part.length) { this.#chunks.push(part); this.#bytes += part.length; }
        if (end === -1) return;
        if (this.#bytes > 0) {
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
    this.writable.destroy();
    this.readable.destroy();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Browser action aborted");
}
