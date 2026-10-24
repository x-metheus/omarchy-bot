import { z } from "zod";
import { isLocalJob, type LocalJob } from "@omarchy-bot/agent-contract";
import { isDeviceId } from "@omarchy-bot/domain";

export { isDeviceId };

/** Local Sidecar OS capabilities. Screenshot and Takeover are Bot Screen, not Sidecar. */
export const DEVICE_CAPABILITIES = ["shell", "search", "files", "transfer"] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const DeviceCapability = z.enum(DEVICE_CAPABILITIES);
export type { LocalJob };

const deviceId = z.string().refine(isDeviceId, "invalid Local Sidecar device identity");
const hostname = z.string().trim().min(1).max(256);

export const DeviceDto = z.object({
  id: deviceId,
  hostname,
  online: z.literal(true),
  capabilities: z.array(DeviceCapability).min(1),
});
export type DeviceDto = z.infer<typeof DeviceDto>;

/** Sidecar → daemon on the dedicated `/api/devices` WebSocket. */
export const DeviceRegisterFrame = z.object({
  type: z.literal("register"),
  deviceId,
  hostname,
  capabilities: z.array(DeviceCapability).min(1),
});
export type DeviceRegisterFrame = z.infer<typeof DeviceRegisterFrame>;

export const DeviceHeartbeatFrame = z.object({
  type: z.literal("heartbeat"),
});
export type DeviceHeartbeatFrame = z.infer<typeof DeviceHeartbeatFrame>;

export const LOCAL_RESULT_TEXT_MAX = 16_384;

export const DeviceLocalResultFrame = z.object({
  type: z.literal("local.result"),
  jobId: z.string().min(1).max(256),
  ok: z.boolean(),
  text: z.string().max(LOCAL_RESULT_TEXT_MAX).optional(),
  error: z.string().max(2_048).optional(),
  exitCode: z.number().int().optional(),
});
export type DeviceLocalResultFrame = z.infer<typeof DeviceLocalResultFrame>;

export type DeviceClientFrame = DeviceRegisterFrame | DeviceHeartbeatFrame | DeviceLocalResultFrame;

/** Daemon → Sidecar on the dedicated `/api/devices` WebSocket. */
export const DeviceRegisteredFrame = z.object({
  type: z.literal("registered"),
  deviceId,
});
export type DeviceRegisteredFrame = z.infer<typeof DeviceRegisteredFrame>;

export const DeviceErrorFrame = z.object({
  type: z.literal("error"),
  error: z.string().min(1),
});
export type DeviceErrorFrame = z.infer<typeof DeviceErrorFrame>;

const DeviceLocalJobEnvelope = z.object({
  type: z.literal("local.job"),
  jobId: z.string().min(1).max(256),
  hostname,
  botId: z.string().min(1),
  turnId: z.string().min(1),
}).passthrough();

export const DeviceLocalCancelFrame = z.object({
  type: z.literal("local.cancel"),
  jobId: z.string().min(1).max(256),
});
export type DeviceLocalCancelFrame = z.infer<typeof DeviceLocalCancelFrame>;

export type DeviceLocalJobFrame = LocalJob & {
  type: "local.job";
  jobId: string;
  hostname: string;
  botId: string;
  turnId: string;
};

export const DeviceServerFrameSchema = z.union([
  DeviceRegisteredFrame,
  DeviceErrorFrame,
  DeviceLocalCancelFrame,
  DeviceLocalJobEnvelope,
]).transform((frame, context): DeviceRegisteredFrame | DeviceErrorFrame | DeviceLocalCancelFrame | DeviceLocalJobFrame => {
  if (frame.type !== "local.job") return frame;
  const { type: _type, jobId: _jobId, hostname: _hostname, botId: _botId, turnId: _turnId, ...job } = frame;
  if (!isLocalJob(job)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "local.job does not match LOCAL_SCHEMA" });
    return z.NEVER;
  }
  return { type: "local.job", jobId: frame.jobId, hostname: frame.hostname, botId: frame.botId, turnId: frame.turnId, ...job };
});
export type DeviceServerFrame = z.infer<typeof DeviceServerFrameSchema>;
