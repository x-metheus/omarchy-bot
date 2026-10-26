import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_MS,
  readJsonl,
  stderr,
  type ToolChannelFrame,
} from "@omarchy-bot/agent-contract";
import {
  anchoredSessionCommand,
  sessionAnchor,
  terminateOwnedSession,
  type OwnedSession,
} from "./ownedProcesses.ts";


export interface WorkerClientOptions {
  name: string;
  script: string;
  args?: string[];
  /** Optional production application-unit wrapper (for example systemd-run --scope). */
  commandPrefix?: string[];
  /** Real desktop env (computer worker) or sanitized env (agent workers). */
  env?: Record<string, string>;
  onEvent: (event: any) => void;
  onExit?: (code: number | null) => void;
  /** Reverse tool traffic; undefined answers every request with an error frame. */
  onToolFrame?: (frame: ToolChannelFrame) => Promise<ToolChannelFrame | undefined>;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One supervised local child process speaking LF-JSONL over stdio.
 * Request/response correlation, heartbeat watchdog, bounded restart backoff.
 */
export class WorkerClient {
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined = undefined;
  #pending = new Map<string, Pending>();
  #hello: { v: number; worker: string; pid: number } | undefined;
  /** Frames written to the worker, so a test can read a result without a second stdout reader. */
  readonly sent: unknown[] = [];
  #lastMessageAt = 0;
  #stopping = false;
  #watchdog?: ReturnType<typeof setInterval>;
  #session: OwnedSession | undefined;
  /** One cleanup per worker generation; every path awaits the same promise. */
  #cleanup: Promise<void> | undefined;
  #generation = 0;

  constructor(private readonly opts: WorkerClientOptions) {}

  get hello(): WorkerClientOptions["name"] | undefined {
    return this.#hello?.worker;
  }
  get alive(): boolean {
    return this.#proc !== undefined && this.#proc.exitCode === null;
  }

  async start(timeoutMs = 15_000): Promise<void> {
    this.#stopping = false;
    this.#cleanup = undefined;
    const generation = ++this.#generation;
    const token = randomUUID();
    const session: OwnedSession = { sessionId: -1, anchor: sessionAnchor(token) };
    const proc = Bun.spawn({
      cmd: anchoredSessionCommand(
        [...(this.opts.commandPrefix ?? []), process.execPath, this.opts.script, ...(this.opts.args ?? [])],
        token,
      ),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Own session: descendants stay findable after they scrub their
      // environment, and nothing but our teardown reaches them.
      detached: true,
      env: this.opts.env ?? {},
      onExit: (_exited, exitCode) => {
        // A late exit from a replaced generation must not disturb its successor.
        if (generation !== this.#generation) {
          void this.#terminate(session).catch((error: unknown) => {
            stderr(`${this.opts.name}: cleanup after late exit failed: ${String(error)}`);
          });
          return;
        }
        clearInterval(this.#watchdog);
        for (const [, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`${this.opts.name} worker exited (${exitCode})`));
        }
        this.#pending.clear();
        this.#proc = undefined;
        this.#hello = undefined;
        // The leader is gone but its descendants are not: reap them before any
        // restart can start a second copy of the same work. Assigning the shared
        // promise first lets a concurrent stop await the same cleanup.
        void (this.#cleanup ??= this.#terminate(session)).then(
          () => {
            if (!this.#stopping) this.opts.onExit?.(exitCode);
          },
          (error: unknown) => {
            // A restart must not hide a failed teardown: report it as the crash.
            stderr(`${this.opts.name}: cleanup after exit failed: ${String(error)}`);
            if (!this.#stopping) this.opts.onExit?.(exitCode);
          },
        );
      },
    });
    session.sessionId = proc.pid;
    this.#session = session;
    this.#proc = proc;

    void readJsonl(
      proc.stdout as unknown as ReadableStream<Uint8Array>,
      (msg) => this.#onMessage(msg),
      () => {},
    );
    void this.#drainStderr(proc.stderr as unknown as ReadableStream<Uint8Array>);

    // Handshake: first frame must be hello.
    try {
      const handshake = Promise.withResolvers<void>();
      const check = setInterval(() => {
        if (this.#hello) {
          handshake.resolve();
        } else if (!this.alive) {
          handshake.reject(new Error(`${this.opts.name} worker died during handshake`));
        }
      }, 25);
      const timeout = setTimeout(
        () => handshake.reject(new Error(`${this.opts.name} worker handshake timeout`)),
        timeoutMs,
      );
      this.#lastMessageAt = Date.now();
      this.#watchdog = setInterval(() => {
        if (Date.now() - this.#lastMessageAt > HEARTBEAT_MS * 2.5) {
          stderr(`${this.opts.name} heartbeat missed; killing`);
          void (this.#cleanup ??= this.#terminate(session)).catch((error: unknown) => {
            stderr(`${this.opts.name}: heartbeat cleanup failed: ${String(error)}`);
          });
        }
      }, HEARTBEAT_MS);
      try {
        await handshake.promise;
      } finally {
        // Settled either way: no interval may outlive the handshake.
        clearInterval(check);
        clearTimeout(timeout);
      }
    } catch (error) {
      // A worker that never became usable must not leave owned processes behind,
      // and no watchdog may outlive it.
      clearInterval(this.#watchdog);
      await (this.#cleanup ??= this.#terminate(session));
      throw error;
    }
  }

  /**
   * Stops one worker generation's session: identity-verified members, TERM then
   * KILL, including descendants that scrubbed their environment. Shared so exit,
   * watchdog, handshake failure and stop await one cleanup.
   */
  #terminate(session: OwnedSession | undefined, graceMs?: number): Promise<void> {
    if (session === undefined || session.sessionId <= 0) return Promise.resolve();
    return graceMs === undefined ? terminateOwnedSession(session) : terminateOwnedSession(session, graceMs);
  }

  async #drainStderr(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = dec.decode(value);
        for (const line of text.split("\n")) if (line.trim()) stderr(`${this.opts.name}: ${line}`);
      }
    } catch {
      /* worker died */
    }
  }

  #onMessage(raw: unknown): void {
    this.#lastMessageAt = Date.now();
    const msg = raw as any;
    if (msg?.type === "hello") {
      this.#hello = msg;
      return;
    }
    if (msg?.type === "heartbeat") return;
    if (msg?.type === "tool.request") {
      if (
        typeof msg.requestId !== "string"
        || typeof msg.name !== "string"
        || typeof msg.context?.workerSessionId !== "string"
      ) {
        if (this.alive) {
          this.write({
            type: "tool.result",
            requestId: typeof msg.requestId === "string" ? msg.requestId : "",
            ok: false,
            error: "invalid tool request frame",
          });
        }
        return;
      }
      void this.#handleToolFrame(msg as ToolChannelFrame);
      return;
    }
    if (msg?.type === "tool.cancel") {
      void this.#handleToolFrame(msg as ToolChannelFrame);
      return;
    }
    if (msg?.type === "event") {
      this.opts.onEvent(msg.event);
      return;
    }
    if (msg?.requestId && this.#pending.has(msg.requestId)) {
      const p = this.#pending.get(msg.requestId)!;
      this.#pending.delete(msg.requestId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(String(msg.error)));
    }
  }

  async #handleToolFrame(frame: ToolChannelFrame): Promise<void> {
    if (this.opts.onToolFrame === undefined) {
      if (frame.type === "tool.request" && this.alive) {
        this.write({ type: "tool.result", requestId: frame.requestId, ok: false, error: `${this.opts.name} cannot route tool calls` });
      }
      return;
    }
    const result = await this.opts.onToolFrame(frame);
    if (result !== undefined && this.alive) this.write(result);
  }

  /** Send a command and await its result. Mutating worker commands are never auto-retried. */
  async request(cmd: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.alive) throw new Error(`${this.opts.name} worker not running`);
    const requestId = (cmd.requestId as string) ?? randomUUID();
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${this.opts.name} request ${cmd.type} timed out`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
    });
    this.write({ ...cmd, requestId });
    return p;
  }

  write(obj: unknown): void {
    const stdin = (this.#proc as unknown as { stdin?: { write: (s: string) => void; flush?: () => void } } | undefined)?.stdin;
    if (!stdin) throw new Error(`${this.opts.name} worker not running`);
    stdin.write(JSON.stringify(obj) + "\n");
    stdin.flush?.();
    this.sent.push(obj);
  }

  async stop(graceMs = 3000): Promise<void> {
    this.#stopping = true;
    if (this.alive) {
      try {
        this.#proc?.stdin.end();
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + graceMs;
      while (this.alive && Date.now() < deadline) await Bun.sleep(50);
    }
    // Graceful shutdown, a leader that exits early, and a TERM-resistant worker
    // all end the same way: nothing in this generation's session survives.
    // An exit already in flight owns the cleanup, so await it instead of repeating it.
    await (this.#cleanup ??= this.#terminate(this.#session, graceMs));
  }
}

/** Agent workers get a sanitized desktop env. */
export function sanitizedEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OMARCHY_BOT_HOME", "NO_COLOR"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}
