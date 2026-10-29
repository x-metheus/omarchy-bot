import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinedPath } from "../../../packages/domain/src/paths.ts";
import type { DeviceClientFrame, DeviceRegisterFrame, DeviceLocalJobFrame, DeviceServerFrame } from "../../../packages/protocol/src/index.ts";
import { sidecarCommand } from "./sidecarCommand.ts";

interface LocalSidecarRegistration {
  deviceId: string;
  hostname: string;
}

/** Raw device channel for daemon registration validation and session replacement. */
export class DeviceChannel {
  readonly frames: DeviceServerFrame[] = [];
  #closed = Promise.withResolvers<void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as DeviceServerFrame));
    ws.addEventListener("close", () => this.#closed.resolve());
  }

  static async connect(port: number, token: string): Promise<DeviceChannel> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices?access_token=${encodeURIComponent(token)}`);
    const channel = new DeviceChannel(ws);
    await waitOpen(ws);
    return channel;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  async register(registration: LocalSidecarRegistration & {
    os?: DeviceRegisterFrame["os"];
    shell?: DeviceRegisterFrame["shell"];
    capabilities: DeviceRegisterFrame["capabilities"];
  }): Promise<DeviceServerFrame> {
    this.send({ type: "register", os: "linux", shell: "posix-sh", ...registration });
    return this.waitForFrame((frame) => frame.type === "registered" || frame.type === "error");
  }

  heartbeat(): void {
    this.send({ type: "heartbeat" });
  }

  async waitForFrame(predicate: (frame: DeviceServerFrame) => boolean): Promise<DeviceServerFrame> {
    await until(() => this.frames.some(predicate), "device channel never received the expected frame");
    return this.frames.find(predicate)!;
  }

  get closed(): boolean {
    return this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.#closed.promise;
  }
}

/** Real Rust process, with a recording proxy preserving daemon job/Turn observations. */
export class LocalSidecarFixture {
  readonly frames: DeviceServerFrame[] = [];
  readonly clientFrames: DeviceClientFrame[] = [];
  readonly sandbox = mkdtempSync(path.join(os.tmpdir(), "omarchy-local-sidecar-"));
  readonly executed: string[] = [];
  readonly denied: string[] = [];
  #asks = new Set<string>();
  #observedAsks = new Set<string>();
  #autoAllow = false;
  #child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #proxy?: Bun.Server<WebSocket>;
  #output?: Promise<void>;
  #errors?: Promise<void>;
  #stderr = "";

  private constructor(private readonly port: number, private readonly token: string) {}

  static async connect(port: number, token: string, policy?: { always?: string[]; never?: string[] }): Promise<LocalSidecarFixture> {
    const fixture = new LocalSidecarFixture(port, token);
    if (policy) writeFileSync(path.join(fixture.sandbox, ".omarchy-bot-local-policy.json"), JSON.stringify({ always: [], never: [], ...policy }));
    return fixture;
  }

  async register(registration: LocalSidecarRegistration): Promise<DeviceServerFrame> {
    const fixture = this;
    this.#proxy = Bun.serve<WebSocket>({
      hostname: "127.0.0.1", port: 0,
      async fetch(request, server) {
        const upstream = new WebSocket(`ws://127.0.0.1:${fixture.port}/api/devices?access_token=${encodeURIComponent(fixture.token)}`);
        await waitOpen(upstream);
        if (server.upgrade(request, { data: upstream })) return;
        upstream.close();
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(client) {
          client.data.addEventListener("message", (event) => {
            const raw = String(event.data);
            fixture.frames.push(JSON.parse(raw) as DeviceServerFrame);
            client.send(raw);
          });
          client.data.addEventListener("close", () => client.close());
        },
        message(client, message) {
          const raw = String(message);
          const frame = JSON.parse(raw) as DeviceClientFrame;
          fixture.clientFrames.push(frame);
          if (frame.type === "local.result") {
            const job = fixture.jobs().find((job) => job.jobId === frame.jobId);
            if (job) {
              const value = job.command ?? job.query ?? job.path ?? "";
              const rule = `${job.action}:${value}`;
              if (frame.ok) fixture.executed.push(job.action === "run" ? value : rule);
              else if (frame.error?.includes("denied") || frame.error?.includes("Never allowed")) fixture.denied.push(rule);
            }
          }
          client.data.send(raw);
        },
        close(client) { client.data.close(); },
      },
    });
    this.#child = Bun.spawn(sidecarCommand, {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${this.#proxy.port}`,
        OMARCHY_BOT_DEVICE_ID: registration.deviceId,
        OMARCHY_BOT_DEVICE_TOKEN: this.token,
        OMARCHY_BOT_HOSTNAME: registration.hostname,
        OMARCHY_BOT_SIDECAR_ROOT: this.sandbox,
      },
    });
    const child = this.#child;
    this.#output = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const frame = JSON.parse(pending.slice(0, newline)) as { type: string; jobId?: string };
          pending = pending.slice(newline + 1);
          if (frame.jobId && frame.type === "ask") {
            this.#asks.add(frame.jobId);
            if (this.#autoAllow) this.#decide(frame.jobId, "allow-once");
          } else if (frame.jobId && frame.type === "ask.dismiss") this.#asks.delete(frame.jobId);
        }
      }
    })();
    this.#errors = (async () => { this.#stderr = await new Response(child.stderr).text(); })();
    try {
      return await this.waitForFrame((frame) => frame.type === "registered" || frame.type === "error");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  jobs(): DeviceLocalJobFrame[] {
    return this.frames.filter((frame): frame is DeviceLocalJobFrame => frame.type === "local.job");
  }

  async waitForJob(timeoutMs = 8_000): Promise<DeviceLocalJobFrame> {
    await until(() => this.jobs().some((job) => this.#asks.has(job.jobId) && !this.#observedAsks.has(job.jobId)), "Local Sidecar never asked for the expected job", timeoutMs);
    const job = this.jobs().find((job) => this.#asks.has(job.jobId) && !this.#observedAsks.has(job.jobId))!;
    this.#observedAsks.add(job.jobId);
    return job;
  }

  async allowOnce(jobId?: string): Promise<void> { this.#decide(jobId, "allow-once"); }
  async denyOnce(jobId?: string): Promise<void> { this.#decide(jobId, "deny"); }
  async remember(jobId: string, decision: "always" | "never"): Promise<void> { this.#decide(jobId, decision); }

  autoAllow(): void {
    this.#autoAllow = true;
    for (const id of this.#asks) this.#decide(id, "allow-once");
  }

  async waitForFrame(predicate: (frame: DeviceServerFrame) => boolean, timeoutMs = 5_000): Promise<DeviceServerFrame> {
    await until(() => {
      if (this.#child?.exitCode !== null && this.#child?.exitCode !== undefined) throw new Error(`Local Sidecar exited: ${this.#stderr}`);
      return this.frames.some((frame) => predicate(frame) && (frame.type !== "local.cancel" || !this.#asks.has(frame.jobId)));
    }, "Local Sidecar never received the expected device-channel frame", timeoutMs);
    return this.frames.find(predicate)!;
  }

  async close(): Promise<void> {
    this.#child?.stdin.end();
    try {
      if (this.#child) {
        await until(() => this.#child!.exitCode !== null, "Local Sidecar did not stop after stdin closed");
        await this.#child.exited;
      }
    } finally {
      if (this.#child?.exitCode === null) { this.#child.kill(); await this.#child.exited; }
      await this.#proxy?.stop(true);
      await Promise.all([this.#output, this.#errors]);
      rmSync(this.sandbox, { recursive: true, force: true });
    }
  }

  sandboxPath(relative: string): string { return confinedPath(relative, this.sandbox); }

  #decide(jobId: string | undefined, decision: "allow-once" | "deny" | "always" | "never"): void {
    const id = jobId ?? [...this.#asks].at(-1);
    if (id === undefined || !this.#asks.delete(id) || !this.#child) throw new Error("no Local Sidecar job waiting for a decision");
    this.#child.stdin.write(`${JSON.stringify({ type: decision, jobId: id })}\n`);
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("Local Sidecar device channel failed to connect")), { once: true });
  return promise;
}

async function until(probe: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}
