import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LOCAL_RESULT_TEXT_MAX,
  DeviceLocalResultFrame,
  DeviceRegisterFrame,
  DeviceServerFrameSchema,
  type DeviceCapability,
  type DeviceDto,
  type DeviceLocalJobFrame,
  type DeviceServerFrame,
  type LocalJob,
} from "@omarchy-bot/protocol";
import { LOCAL_CONTENTS_MAX_LENGTH } from "@omarchy-bot/agent-contract";
import { confinedPath } from "@omarchy-bot/domain";

/** One outbound Local Sidecar connection: the WebSocket in production, a recorder in tests. */
export interface DevicePort {
  send(frame: DeviceServerFrame): void;
  close(code?: number, reason?: string): void;
}

const LOCAL_OUTPUT_MAX = 8_192;
const HEARTBEAT_TIMEOUT_MS = 30_000;

const ACTION_CAPABILITY: Record<DeviceLocalJobFrame["action"], DeviceCapability> = {
  run: "shell",
  search: "search",
  read: "files",
  write: "files",
  transfer: "transfer",
};

function redactLocalOutput(text: string): string {
  return text
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .slice(0, LOCAL_OUTPUT_MAX);
}

interface OnlineDevice {
  id: string;
  hostname: string;
  capabilities: DeviceCapability[];
  port: DevicePort;
  lastHeartbeat: number;
}

interface PendingJob {
  port: DevicePort;
  deviceId: string;
  action: DeviceLocalJobFrame["action"];
  resolve: (result: { text: string; exitCode?: number }) => void;
  reject: (error: Error) => void;
}

/** Online Local Sidecars plus their in-flight `local` jobs, keyed by This Device identity. */
export class SidecarBroker {
  readonly #devices = new Map<string, OnlineDevice>();
  readonly #jobs = new Map<string, PendingJob>();

  constructor(
    private readonly sharedWorkspaceDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  list(): DeviceDto[] {
    return [...this.#devices.values()].map((device) => ({
      id: device.id,
      hostname: device.hostname,
      online: true as const,
      capabilities: device.capabilities,
    }));
  }

  get(deviceId: string): DeviceDto | undefined {
    const device = this.#devices.get(deviceId);
    if (device === undefined) return undefined;
    return {
      id: device.id,
      hostname: device.hostname,
      online: true,
      capabilities: device.capabilities,
    };
  }

  register(
    port: DevicePort,
    raw: unknown,
  ): { ok: true; device: DeviceDto } | { ok: false; error: string } {
    const parsed = DeviceRegisterFrame.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid Local Sidecar registration" };
    }
    const frame = parsed.data;
    const existing = this.#devices.get(frame.deviceId);
    if (existing !== undefined && existing.port !== port) {
      existing.port.close(4000, "Local Sidecar session replaced");
      this.#failDeviceJobs(frame.deviceId, "Local Sidecar session replaced");
    }
    const device: DeviceDto = {
      id: frame.deviceId,
      hostname: frame.hostname,
      online: true,
      capabilities: frame.capabilities,
    };
    this.#devices.set(frame.deviceId, { ...device, port, lastHeartbeat: this.now() });
    return { ok: true, device };
  }

  disconnect(port: DevicePort, deviceId: string | undefined): void {
    if (deviceId === undefined) return;
    const current = this.#devices.get(deviceId);
    if (current?.port !== port) return;
    this.#devices.delete(deviceId);
    this.#failDeviceJobs(deviceId, "Local Sidecar disconnected");
  }

  heartbeat(port: DevicePort, deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device === undefined || device.port !== port) return;
    device.lastHeartbeat = this.now();
  }

  /** Drop devices silent for 30 s; their jobs fail because the device is gone. */
  expire(): void {
    const at = this.now();
    for (const [deviceId, device] of [...this.#devices]) {
      if (at - device.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) continue;
      this.#devices.delete(deviceId);
      device.port.close(4001, "Local Sidecar heartbeat expired");
      this.#failDeviceJobs(deviceId, "Local Sidecar heartbeat expired");
    }
  }

  /**
   * Run one `local` job on This Device (or an explicitly named online device).
   * The job lives as long as `signal`; there is no job timeout of its own.
   */
  async execute(
    params: LocalJob,
    context: { botId: string; turnId: string; deviceId?: string },
    signal: AbortSignal,
  ): Promise<{ deviceId: string; hostname: string; text: string; exitCode?: number }> {
    const device = this.#resolve(params.target, context.deviceId);
    const capability = ACTION_CAPABILITY[params.action];
    if (!device.capabilities.includes(capability)) {
      throw new Error(`Local Sidecar ${device.hostname} cannot ${params.action}`);
    }
    if (params.action === "search" && (params.query === "/" || params.path === "/")) {
      throw new Error("Local Sidecar search cannot scan /");
    }
    signal.throwIfAborted();

    const contents = this.#transferContents(params);
    signal.throwIfAborted();

    const jobId = randomUUID();
    const frame: DeviceLocalJobFrame = {
      type: "local.job",
      jobId,
      action: params.action,
      hostname: device.hostname,
      botId: context.botId,
      turnId: context.turnId,
      ...(params.command !== undefined ? { command: params.command } : {}),
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.destination !== undefined ? { destination: params.destination } : {}),
      ...(params.query !== undefined ? { query: params.query } : {}),
      ...(contents !== undefined ? { contents } : {}),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    };

    if (contents !== undefined && contents.length > LOCAL_CONTENTS_MAX_LENGTH) {
      throw new Error(`Local Sidecar job rejected before dispatch: contents is ${contents.length} characters, limit is ${LOCAL_CONTENTS_MAX_LENGTH}`);
    }

    // Canonical device schema (LOCAL_SCHEMA) must accept the assembled frame before dispatch.
    const canonical = DeviceServerFrameSchema.safeParse(frame);
    if (!canonical.success) {
      throw new Error("Local Sidecar job rejected before dispatch: frame does not match the canonical local-job schema");
    }

    const port = device.port;
    const { promise, resolve, reject } = Promise.withResolvers<{ text: string; exitCode?: number }>();
    const onAbort = (): void => {
      if (this.#jobs.get(jobId) === undefined) return;
      this.#jobs.delete(jobId);
      port.send({ type: "local.cancel", jobId });
      reject(signal.reason instanceof Error ? signal.reason : new Error("Local Sidecar job aborted"));
    };
    this.#jobs.set(jobId, { port, deviceId: device.id, action: params.action, resolve, reject });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      port.send(canonical.data);
    } catch (error) {
      this.#jobs.delete(jobId);
      signal.removeEventListener("abort", onAbort);
      throw error;
    }

    let result: { text: string; exitCode?: number };
    try {
      result = await promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    // Abort landed between the result and the workspace write: the write must not happen.
    if (signal.aborted) {
      port.send({ type: "local.cancel", jobId });
      signal.throwIfAborted();
    }
    if (params.action === "transfer" && params.direction === "to-workspace") {
      const destination = confinedPath(params.destination ?? "", this.sharedWorkspaceDir);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, result.text);
    }
    return {
      deviceId: device.id,
      hostname: device.hostname,
      text: params.action === "transfer" ? result.text.slice(0, LOCAL_RESULT_TEXT_MAX) : result.text,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  }

  /** Accept a result only from the port and device that own the job. */
  complete(port: DevicePort, deviceId: string, raw: unknown): void {
    const parsed = DeviceLocalResultFrame.safeParse(raw);
    const jobId = parsed.success ? parsed.data.jobId : jobIdOf(raw);
    if (jobId === undefined) return;
    const pending = this.#jobs.get(jobId);
    if (pending === undefined || pending.port !== port || pending.deviceId !== deviceId) return;
    this.#jobs.delete(jobId);
    if (!parsed.success) {
      pending.reject(new Error(`local.result frame for job ${jobId} did not parse`));
      return;
    }
    if (parsed.data.ok) {
      const text = parsed.data.text ?? "";
      pending.resolve({
        text: pending.action === "transfer" ? text : redactLocalOutput(text),
        ...(parsed.data.exitCode !== undefined ? { exitCode: parsed.data.exitCode } : {}),
      });
      return;
    }
    pending.reject(new Error(parsed.data.error ?? "Local Sidecar job failed"));
  }

  close(): void {
    for (const device of this.#devices.values()) {
      device.port.close(1001, "Local Sidecar broker closed");
    }
    this.#devices.clear();
    for (const pending of this.#jobs.values()) {
      pending.reject(new Error("Local Sidecar broker closed"));
    }
    this.#jobs.clear();
  }

  /** This Device comes only from the Turn's claimed device id; no singleton fallback. */
  #resolve(target: string | undefined, thisDeviceId: string | undefined): OnlineDevice {
    if (target !== undefined && target !== "this-device") {
      const device = this.#devices.get(target);
      if (device === undefined) throw new Error("Local Sidecar is offline or unknown");
      return device;
    }
    if (thisDeviceId === undefined) {
      throw new Error("no This Device is known for this Turn; name an explicit Local Sidecar identity");
    }
    const device = this.#devices.get(thisDeviceId);
    if (device === undefined) throw new Error("This Device is offline or unknown");
    return device;
  }

  #transferContents(params: LocalJob): string | undefined {
    if (params.action !== "transfer" || params.direction !== "from-workspace") return params.contents;
    const source = confinedPath(params.path ?? "", this.sharedWorkspaceDir);
    return readFileSync(source, "utf8");
  }

  #failDeviceJobs(deviceId: string, error: string): void {
    for (const [jobId, pending] of [...this.#jobs.entries()]) {
      if (pending.deviceId !== deviceId) continue;
      this.#jobs.delete(jobId);
      pending.reject(new Error(error));
    }
  }
}

function jobIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("jobId" in raw)) return undefined;
  const jobId = raw.jobId;
  return typeof jobId === "string" && jobId.length > 0 ? jobId : undefined;
}
