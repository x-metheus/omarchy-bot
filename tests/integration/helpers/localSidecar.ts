import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinedPath } from "../../../packages/domain/src/paths.ts";
import type {
  DeviceClientFrame,
  DeviceLocalJobFrame,
  DeviceServerFrame,
} from "../../../packages/protocol/src/index.ts";
import {
  createLocalJobHandler,
  type LocalAsk,
  type LocalAskDecision,
} from "../../../apps/sidecar/src/handler.ts";

export interface LocalSidecarRegistration {
  deviceId: string;
  hostname: string;
  capabilities: Array<"shell" | "search" | "files" | "transfer">;
}

/** In-process adapter over the real Sidecar handler and a scripted approver. */
export class LocalSidecarFixture {
  readonly frames: DeviceServerFrame[] = [];
  readonly sandbox: string;
  readonly executed: string[] = [];
  readonly denied: string[] = [];
  #closed = Promise.withResolvers<void>();
  #asks = new Map<string, { resolve(decision: LocalAskDecision): void }>();
  #autoAllow = false;
  #observing = true;
  #handler;

  private constructor(private readonly ws: WebSocket, sandbox: string) {
    this.sandbox = sandbox;
    this.#handler = createLocalJobHandler({
      root: sandbox,
      approver: {
        ask: (ask) => {
          if (this.#autoAllow) return Promise.resolve("allow-once");
          const decision = Promise.withResolvers<LocalAskDecision>();
          this.#asks.set(ask.jobId, decision);
          void ask.dismissed.then(() => this.#asks.delete(ask.jobId));
          return decision.promise;
        },
      },
      send: (frame) => this.send(frame),
      observe: (event) => {
        const value = event.rule.slice(event.rule.indexOf(":") + 1);
        const label = event.rule.startsWith("run:") ? value
          : event.rule.startsWith("search:") ? `search:${value}`
          : event.rule.startsWith("read:") ? `read:${value}`
          : event.rule.startsWith("write:") ? `write:${value}`
          : `transfer:${value}`;
        if (!this.#observing) return;
        if (event.executed) this.executed.push(label);
        else this.denied.push(event.rule);
      },
    });
    ws.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as DeviceServerFrame;
        this.frames.push(frame);
        this.#handler.receive(frame);
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener("close", () => {
      void this.#handler.close().catch(() => undefined);
      this.#closed.resolve();
    });
  }

  static async connect(port: number, token?: string): Promise<LocalSidecarFixture> {
    const query = token ? `?access_token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices${query}`);
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
    const seen = new Set(this.#asks.keys());
    const frame = await this.waitForFrame(
      (candidate) => candidate.type === "local.job" && !seen.has(candidate.jobId) && this.#asks.has(candidate.jobId),
      timeoutMs,
    );
    return frame as DeviceLocalJobFrame;
  }

  async allowOnce(jobId?: string): Promise<void> {
    this.#decide(jobId, "allow-once");
  }

  async denyOnce(jobId?: string): Promise<void> {
    this.#decide(jobId, "deny");
  }

  async alwaysAllow(rule: string): Promise<void> {
    await this.#seed(rule, "always");
  }

  async neverAllow(rule: string): Promise<void> {
    await this.#seed(rule, "never");
  }

  autoAllow(): void {
    this.#autoAllow = true;
    for (const ask of this.#asks.values()) ask.resolve("allow-once");
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
    await this.#handler.close();
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.#closed.promise;
  }

  sandboxPath(relative: string): string {
    return confinedPath(relative, this.sandbox);
  }

  async #seed(rule: string, decision: "always" | "never"): Promise<void> {
    const split = rule.indexOf(":");
    const action = rule.slice(0, split);
    const value = rule.slice(split + 1);
    const job = {
      type: "local.job" as const,
      jobId: `policy-${decision}-${rule}`,
      action: action as DeviceLocalJobFrame["action"],
      hostname: "policy",
      botId: "bot",
      turnId: "turn",
      ...(action === "run" ? { command: value } : action === "search" ? { query: value } : { path: value }),
    };
    this.#observing = false;
    this.#handler.receive(job);
    this.#asks.get(job.jobId)?.resolve(decision);
    await Promise.resolve();
    this.#observing = true;
  }

  #decide(jobId: string | undefined, decision: LocalAskDecision): void {
    const id = jobId ?? [...this.#asks.keys()].at(-1);
    const ask = id === undefined ? undefined : this.#asks.get(id);
    if (ask === undefined || id === undefined) throw new Error("no Local Sidecar job waiting for a decision");
    this.#asks.delete(id);
    ask.resolve(decision);
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Local Sidecar device channel failed to connect")), { once: true });
  });
}

export type { LocalAsk };
