import { describe, expect, test } from "bun:test";
import {
  DeviceDto,
  DeviceErrorFrame,
  DeviceHeartbeatFrame,
  DeviceRegisterFrame,
  DeviceRegisteredFrame,
  DeviceServerFrameSchema,
} from "./devices.ts";

const deviceId = "dev_0123456789abcdef0123456789abcdef";

describe("Local Sidecar device roster DTOs", () => {
  test("accepts an online Sidecar with shell, search, files, and transfer", () => {
    expect(DeviceDto.parse({
      id: deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: true,
      capabilities: ["shell", "search", "files", "transfer"],
    })).toEqual({
      id: deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: true,
      capabilities: ["shell", "search", "files", "transfer"],
    });
  });

  test("rejects screenshot, Takeover, and malformed device identities", () => {
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: true,
      capabilities: ["screenshot"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: true,
      capabilities: ["Takeover"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: "bot_0123456789abcdef0123456789abcdef",
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: true,
      capabilities: ["shell"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      online: false,
      capabilities: ["shell"],
    }).success).toBeFalse();
  });
});

describe("Local Sidecar device channel frames", () => {
  test("accepts register and heartbeat from an outbound Sidecar", () => {
    expect(DeviceRegisterFrame.parse({
      type: "register",
      deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      capabilities: ["shell"],
    }).type).toBe("register");
    expect(DeviceHeartbeatFrame.parse({ type: "heartbeat" })).toEqual({ type: "heartbeat" });
    expect(DeviceRegisteredFrame.parse({ type: "registered", deviceId }).deviceId).toBe(deviceId);
    expect(DeviceErrorFrame.parse({ type: "error", error: "invalid Local Sidecar registration" }).error)
      .toBe("invalid Local Sidecar registration");
  });

  test("rejects register frames that claim screenshot or Takeover", () => {
    expect(DeviceRegisterFrame.safeParse({
      type: "register",
      deviceId,
      hostname: "laptop",
      os: "linux", shell: "posix-sh",
      capabilities: ["shell", "screenshot"],
    }).success).toBeFalse();
    expect(DeviceRegisterFrame.safeParse({
      type: "register",
      deviceId,
      hostname: "",
      os: "linux", shell: "posix-sh",
      capabilities: ["shell"],
    }).success).toBeFalse();
  });
});

describe("Local Sidecar local job frames", () => {
  test("accepts a run job bound to Bot and Turn", () => {
    expect(DeviceServerFrameSchema.parse({
      type: "local.job",
      jobId: "job-1",
      action: "run",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
      command: "echo sidecar-sentinel",
    })).toMatchObject({ command: "echo sidecar-sentinel" });
    expect(DeviceServerFrameSchema.parse({ type: "local.cancel", jobId: "job-1" })).toEqual({
      type: "local.cancel",
      jobId: "job-1",
    });
  });

  test("rejects screenshot actions on the Sidecar job frame", () => {
    expect(DeviceServerFrameSchema.safeParse({
      type: "local.job",
      jobId: "job-1",
      action: "screenshot",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
    }).success).toBeFalse();
  });
});
