import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
  DeviceLocalResultFrame,
  DeviceRegisterFrame,
  type DeviceDto,
  type DeviceLocalJobFrame,
} from "@omarchy-bot/protocol";

const LOCAL_OUTPUT_MAX = 8_192;

function redactLocalOutput(text: string): string {
  return text
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .slice(0, LOCAL_OUTPUT_MAX);
}

/** Process-state roster of online outbound Local Sidecars. */
export class DeviceRoster {
  readonly #devices = new Map<string, {
    id: string;
    hostname: string;
    capabilities: DeviceDto["capabilities"];
    socket: ServerWebSocket<unknown>;
  }>();
  readonly #jobs = new Map<string, {
    deviceId: string;
    action: DeviceLocalJobFrame["action"];
    resolve: (result: { text: string; exitCode?: number }) => void;
    reject: (error: Error) => void;
  }>();

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

  /** this-device when exactly one Sidecar is online. Zero or many stay fail-closed. */
  thisDevice(): DeviceDto | undefined {
    const devices = this.list();
    return devices.length === 1 ? devices[0] : undefined;
  }

  resolve(target: string | undefined): DeviceDto {
    if (target === undefined || target === "this-device") {
      const devices = this.list();
      if (devices.length === 0) {
        throw new Error("no Local Sidecar is online for this-device");
      }
      if (devices.length > 1) {
        throw new Error("this-device is ambiguous; name an explicit Local Sidecar identity");
      }
      return devices[0]!;
    }
    const device = this.get(target);
    if (device === undefined) {
      throw new Error("Local Sidecar is offline or unknown");
    }
    return device;
  }

  register(
    socket: ServerWebSocket<unknown>,
    raw: unknown,
  ): { ok: true; device: DeviceDto } | { ok: false; error: string } {
    const parsed = DeviceRegisterFrame.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid Local Sidecar registration" };
    }
    const frame = parsed.data;
    const existing = this.#devices.get(frame.deviceId);
    if (existing !== undefined && existing.socket !== socket) {
      existing.socket.close(4000, "Local Sidecar session replaced");
      this.#failDeviceJobs(frame.deviceId, "Local Sidecar session replaced");
    }
    const device: DeviceDto = {
      id: frame.deviceId,
      hostname: frame.hostname,
      online: true,
      capabilities: frame.capabilities,
    };
    this.#devices.set(frame.deviceId, { ...device, socket });
    return { ok: true, device };
  }

  disconnect(socket: ServerWebSocket<unknown>, deviceId: string | undefined): void {
    if (deviceId === undefined) return;
    const current = this.#devices.get(deviceId);
    if (current?.socket !== socket) return;
    this.#devices.delete(deviceId);
    this.#failDeviceJobs(deviceId, "Local Sidecar disconnected");
  }

  async dispatch(job: Omit<DeviceLocalJobFrame, "type" | "jobId" | "hostname"> & { deviceId: string }): Promise<{
    deviceId: string;
    hostname: string;
    text: string;
    exitCode?: number;
  }> {
    const device = this.#devices.get(job.deviceId);
    if (device === undefined) throw new Error("Local Sidecar is offline or unknown");
    const jobId = randomUUID();
    const frame: DeviceLocalJobFrame = {
      type: "local.job",
      jobId,
      action: job.action,
      hostname: device.hostname,
      botId: job.botId,
      turnId: job.turnId,
      ...(job.command !== undefined ? { command: job.command } : {}),
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.destination !== undefined ? { destination: job.destination } : {}),
      ...(job.query !== undefined ? { query: job.query } : {}),
      ...(job.contents !== undefined ? { contents: job.contents } : {}),
      ...(job.direction !== undefined ? { direction: job.direction } : {}),
    };
    const result = await new Promise<{ text: string; exitCode?: number }>((resolve, reject) => {
      this.#jobs.set(jobId, { deviceId: device.id, action: job.action, resolve, reject });
      device.socket.send(JSON.stringify(frame));
    });
    return { deviceId: device.id, hostname: device.hostname, ...result };
  }

  complete(raw: unknown): void {
    const parsed = DeviceLocalResultFrame.safeParse(raw);
    if (!parsed.success) return;
    const pending = this.#jobs.get(parsed.data.jobId);
    if (pending === undefined) return;
    this.#jobs.delete(parsed.data.jobId);
    if (parsed.data.ok) {
      const text = parsed.data.text ?? "";
      pending.resolve({
        text: pending.action === "transfer" ? text.slice(0, 65_536) : redactLocalOutput(text),
        ...(parsed.data.exitCode !== undefined ? { exitCode: parsed.data.exitCode } : {}),
      });
      return;
    }
    pending.reject(new Error(parsed.data.error ?? "Local Sidecar job failed"));
  }

  #failDeviceJobs(deviceId: string, error: string): void {
    for (const [jobId, pending] of [...this.#jobs.entries()]) {
      if (pending.deviceId !== deviceId) continue;
      this.#jobs.delete(jobId);
      pending.reject(new Error(error));
    }
  }
}
