import { describe, expect, test } from "bun:test";
import {
  DeviceDto,
  DeviceErrorFrame,
  DeviceHeartbeatFrame,
  DeviceLocalJobFrame,
  DeviceLocalResultFrame,
  DeviceRegisterFrame,
  DeviceRegisteredFrame,
} from "./devices.ts";

const deviceId = "dev_0123456789abcdef0123456789abcdef";

describe("Local Sidecar device roster DTOs", () => {
  test("accepts an online Sidecar with shell, search, files, and transfer", () => {
    expect(DeviceDto.parse({
      id: deviceId,
      hostname: "laptop",
      online: true,
      capabilities: ["shell", "search", "files", "transfer"],
    })).toEqual({
      id: deviceId,
      hostname: "laptop",
      online: true,
      capabilities: ["shell", "search", "files", "transfer"],
    });
  });

  test("rejects screenshot, Takeover, and malformed device identities", () => {
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
      online: true,
      capabilities: ["screenshot"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
      online: true,
      capabilities: ["Takeover"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: "bot_0123456789abcdef0123456789abcdef",
      hostname: "laptop",
      online: true,
      capabilities: ["shell"],
    }).success).toBeFalse();
    expect(DeviceDto.safeParse({
      id: deviceId,
      hostname: "laptop",
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
      capabilities: ["shell", "screenshot"],
    }).success).toBeFalse();
    expect(DeviceRegisterFrame.safeParse({
      type: "register",
      deviceId,
      hostname: "",
      capabilities: ["shell"],
    }).success).toBeFalse();
  });
});

describe("Local Sidecar local job frames", () => {
  test("accepts a run job bound to Bot and Turn", () => {
    expect(DeviceLocalJobFrame.parse({
      type: "local.job",
      jobId: "job-1",
      action: "run",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
      command: "echo sidecar-sentinel",
    }).command).toBe("echo sidecar-sentinel");
    expect(DeviceLocalResultFrame.parse({
      type: "local.result",
      jobId: "job-1",
      ok: true,
      text: "sidecar-sentinel",
      exitCode: 0,
    }).ok).toBeTrue();
  });

  test("rejects screenshot actions on the Sidecar job frame", () => {
    expect(DeviceLocalJobFrame.safeParse({
      type: "local.job",
      jobId: "job-1",
      action: "screenshot",
      hostname: "laptop",
      botId: "bot_1",
      turnId: "turn_1",
    }).success).toBeFalse();
  });
});
