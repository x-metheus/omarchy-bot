import { z } from "zod";
import { isDeviceId } from "@omarchy-bot/domain";

/** Local Sidecar OS capabilities. Screenshot and Takeover are Bot Screen, not Sidecar. */
export const DEVICE_CAPABILITIES = ["shell", "search", "files", "transfer"] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const DeviceCapability = z.enum(DEVICE_CAPABILITIES);
export const LocalJobAction = z.enum(["run", "search", "read", "write", "transfer"]);

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

export const DeviceLocalJobFrame = z.object({
  type: z.literal("local.job"),
  jobId: z.string().min(1).max(256),
  action: LocalJobAction,
  hostname,
  botId: z.string().min(1),
  turnId: z.string().min(1),
  command: z.string().min(1).max(8_192).optional(),
  path: z.string().min(1).max(4_096).optional(),
  destination: z.string().min(1).max(4_096).optional(),
  query: z.string().min(1).max(1_024).optional(),
  contents: z.string().max(65_536).optional(),
  direction: z.enum(["to-workspace", "from-workspace"]).optional(),
});
export type DeviceLocalJobFrame = z.infer<typeof DeviceLocalJobFrame>;

export type DeviceServerFrame = DeviceRegisteredFrame | DeviceErrorFrame | DeviceLocalJobFrame;
