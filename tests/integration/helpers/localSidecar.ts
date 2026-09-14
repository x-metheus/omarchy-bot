import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeviceClientFrame,
  DeviceLocalJobFrame,
  DeviceServerFrame,
} from "../../../packages/protocol/src/index.ts";

export interface LocalSidecarRegistration {
  deviceId: string;
  hostname: string;
  capabilities: Array<"shell" | "search" | "files" | "transfer">;
}

const SECRET_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws", ".config"]);
const SEARCH_HIT_LIMIT = 32;
const SNIPPET_MAX = 160;

/** Outbound-only Local Sidecar fixture for the public device WebSocket. */
export class LocalSidecarFixture {
  readonly frames: DeviceServerFrame[] = [];
  readonly sandbox: string;
  readonly executed: string[] = [];
  readonly denied: string[] = [];
  #closed = Promise.withResolvers<void>();
  #autoAllow = false;
  #always = new Set<string>();
  #never = new Set<string>();
  #handled = new Set<string>();
  #policyPath: string;

  private constructor(private readonly ws: WebSocket, sandbox: string) {
    this.sandbox = sandbox;
    this.#policyPath = path.join(sandbox, ".omarchy-bot-local-policy.json");
    this.#loadPolicy();
    ws.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as DeviceServerFrame;
        this.frames.push(frame);
        if (frame.type === "local.job") void this.#onJob(frame);
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener("close", () => this.#closed.resolve());
  }

  static async connect(port: number): Promise<LocalSidecarFixture> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices`);
    await waitOpen(ws);
    return new LocalSidecarFixture(ws, mkdtempSync(path.join(os.tmpdir(), "omarchy-local-sidecar-")));
  }

  send(frame: DeviceClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  async register(registration: LocalSidecarRegistration): Promise<DeviceServerFrame> {
    this.send({
      type: "register",
      deviceId: registration.deviceId,
      hostname: registration.hostname,
      capabilities: registration.capabilities,
    });
    return this.waitForFrame((frame) => frame.type === "registered" || frame.type === "error");
  }

  heartbeat(): void {
    this.send({ type: "heartbeat" });
  }

  jobs(): DeviceLocalJobFrame[] {
    return this.frames.filter((frame): frame is DeviceLocalJobFrame => frame.type === "local.job");
  }

  async waitForJob(timeoutMs = 8_000): Promise<DeviceLocalJobFrame> {
    const frame = await this.waitForFrame(
      (candidate) => candidate.type === "local.job" && !this.#handled.has((candidate as DeviceLocalJobFrame).jobId),
      timeoutMs,
    );
    return frame as DeviceLocalJobFrame;
  }

  async allowOnce(jobId?: string): Promise<void> {
    const job = jobId === undefined
      ? this.jobs().at(-1)
      : this.jobs().find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new Error("no Local Sidecar job waiting for Allow once");
    await this.#execute(job);
  }

  async denyOnce(jobId?: string): Promise<void> {
    const job = jobId === undefined
      ? this.jobs().at(-1)
      : this.jobs().find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new Error("no Local Sidecar job waiting to deny");
    this.#handled.add(job.jobId);
    this.denied.push(this.#ruleKey(job));
    this.send({
      type: "local.result",
      jobId: job.jobId,
      ok: false,
      error: "Local Sidecar denied this work",
    });
  }

  alwaysAllow(rule: string): void {
    this.#always.add(rule);
    this.#savePolicy();
  }

  neverAllow(rule: string): void {
    this.#never.add(rule);
    this.#savePolicy();
  }

  autoAllow(): void {
    this.#autoAllow = true;
    void this.#drainAutoAllow();
  }

  async waitForFrame(
    predicate: (frame: DeviceServerFrame) => boolean,
    timeoutMs = 5_000,
  ): Promise<DeviceServerFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.frames.find(predicate);
      if (frame !== undefined) return frame;
      if (Date.now() > deadline) throw new Error("Local Sidecar never received the expected device-channel frame");
      await Bun.sleep(20);
    }
  }

  get closed(): boolean {
    return this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.#closed.promise;
  }

  async #onJob(job: DeviceLocalJobFrame): Promise<void> {
    if (job.action === "search" && (job.query === "/" || job.path === "/")) {
      this.#handled.add(job.jobId);
      this.send({
        type: "local.result",
        jobId: job.jobId,
        ok: false,
        error: "Local Sidecar search cannot scan /",
      });
      return;
    }
    const key = this.#ruleKey(job);
    if (this.#never.has(key)) {
      this.#handled.add(job.jobId);
      this.denied.push(key);
      this.send({
        type: "local.result",
        jobId: job.jobId,
        ok: false,
        error: "Local Sidecar Never allowed this work",
      });
      return;
    }
    if (this.#always.has(key) || this.#autoAllow) {
      await this.#execute(job);
    }
  }

  async #drainAutoAllow(): Promise<void> {
    while (this.#autoAllow && !this.closed) {
      for (const job of this.jobs()) {
        if (this.#handled.has(job.jobId)) continue;
        await this.#execute(job);
      }
      await Bun.sleep(20);
    }
  }

  #ruleKey(job: DeviceLocalJobFrame): string {
    return `${job.action}:${job.command ?? job.path ?? job.query ?? ""}`;
  }

  #loadPolicy(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#policyPath, "utf8")) as { always?: string[]; never?: string[] };
      for (const rule of parsed.always ?? []) this.#always.add(rule);
      for (const rule of parsed.never ?? []) this.#never.add(rule);
    } catch {
      /* first use */
    }
  }

  #savePolicy(): void {
    writeFileSync(this.#policyPath, JSON.stringify({
      always: [...this.#always],
      never: [...this.#never],
    }));
  }

  sandboxPath(relative: string): string {
    const resolved = path.resolve(this.sandbox, relative);
    const root = path.resolve(this.sandbox);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("Local Sidecar path escapes the sandbox");
    }
    return resolved;
  }

  async #execute(job: DeviceLocalJobFrame): Promise<void> {
    if (this.#handled.has(job.jobId)) return;
    this.#handled.add(job.jobId);
    try {
      if (/\bscreenshot\b|\bpointer\b|SWAYSOCK|WAYLAND_DISPLAY/i.test(`${job.command ?? ""} ${job.path ?? ""}`)) {
        this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "Local Sidecar rejects screenshot, pointer, and Host compositor actions" });
        return;
      }
      if (job.action === "run") {
        if (job.command === undefined) {
          this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "local.run requires a command" });
          return;
        }
        this.executed.push(job.command);
        const proc = Bun.spawn(["/bin/sh", "-c", job.command], {
          cwd: this.sandbox,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        this.send({
          type: "local.result",
          jobId: job.jobId,
          ok: true,
          text: `${stdout}${stderr}`.slice(0, 8_192),
          exitCode,
        });
        return;
      }
      if (job.action === "search") {
        if (job.query === undefined) {
          this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "local.search requires a query" });
          return;
        }
        this.executed.push(`search:${job.query}`);
        this.send({ type: "local.result", jobId: job.jobId, ok: true, text: this.#search(job.query, job.path) });
        return;
      }
      if (job.action === "read") {
        if (job.path === undefined) {
          this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "local.read requires an explicit path" });
          return;
        }
        this.executed.push(`read:${job.path}`);
        const target = this.sandboxPath(job.path);
        this.send({ type: "local.result", jobId: job.jobId, ok: true, text: readFileSync(target, "utf8").slice(0, 8_192) });
        return;
      }
      if (job.action === "write") {
        if (job.path === undefined) {
          this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "local.write requires an explicit path" });
          return;
        }
        this.executed.push(`write:${job.path}`);
        const target = this.sandboxPath(job.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, job.contents ?? "");
        this.send({ type: "local.result", jobId: job.jobId, ok: true, text: `wrote ${job.path}` });
        return;
      }
      if (job.action === "transfer") {
        if (job.direction === "from-workspace") {
          if (job.destination === undefined) {
            this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "transfer onto a Sidecar requires an explicit destination path" });
            return;
          }
          this.executed.push(`transfer:from-workspace:${job.destination}`);
          const target = this.sandboxPath(job.destination);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, job.contents ?? "");
          this.send({ type: "local.result", jobId: job.jobId, ok: true, text: `copied to ${job.destination}` });
          return;
        }
        if (job.path === undefined) {
          this.send({ type: "local.result", jobId: job.jobId, ok: false, error: "transfer into Shared Workspace requires a Sidecar source path" });
          return;
        }
        this.executed.push(`transfer:to-workspace:${job.path}`);
        const source = this.sandboxPath(job.path);
        this.send({ type: "local.result", jobId: job.jobId, ok: true, text: readFileSync(source, "utf8") });
        return;
      }
      this.send({ type: "local.result", jobId: job.jobId, ok: false, error: `unsupported local action ${job.action}` });

    } catch (error) {
      this.send({
        type: "local.result",
        jobId: job.jobId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #search(query: string, explicitRoot?: string): string {
    if (explicitRoot === "/" || query === "/") {
      throw new Error("Local Sidecar search cannot scan /");
    }
    const root = this.sandboxPath(explicitRoot ?? ".");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      if (hits.length >= SEARCH_HIT_LIMIT) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= SEARCH_HIT_LIMIT) return;
        if (SECRET_DIR_NAMES.has(name)) continue;
        const full = path.join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        let body = "";
        try {
          body = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (!full.includes(query) && !body.includes(query)) continue;
        const relative = path.relative(this.sandbox, full);
        const line = body.split("\n").find((candidate) => candidate.includes(query)) ?? "";
        hits.push(`${relative}: ${line.slice(0, SNIPPET_MAX)}`);
      }
    };
    walk(root);
    return hits.join("\n").slice(0, 8_192);
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Local Sidecar device channel failed to connect")), { once: true });
  });
}
