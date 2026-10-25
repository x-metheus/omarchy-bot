import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto, MessageDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  makeBot,
  messages,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface SessionObservation {
  type: string;
  botId?: string;
  threadId?: string;
  options?: { cwd?: string };
}

function workerObservations(h: Harness): SessionObservation[] {
  const log = path.join(h.home, "fake-agent-observations.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionObservation);
}

function toolNamed(transcript: MessageDto[], name: string): MessageDto | undefined {
  return transcript.find((message) => message.kind === "tool" && message.toolCall?.name === name);
}

async function waitRoster(
  h: Harness,
  predicate: (devices: DeviceDto[]) => boolean,
  timeoutMs = 5_000,
): Promise<DeviceDto[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const devices = await api<DeviceDto[]>(h, "GET", "/api/devices");
    if (predicate(devices)) return devices;
    if (Date.now() > deadline) throw new Error("device roster never matched");
    await Bun.sleep(40);
  }
}

describe("fail closed and keep Sidecars distinct", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  async function connect(): Promise<LocalSidecarFixture> {
    const sidecar = await LocalSidecarFixture.connect(h!.port, h!.token);
    sidecars.push(sidecar);
    return sidecar;
  }

  test("with no online Sidecar this-device fails and plugin-host Agent work continues", async () => {
    h = await startDaemon();
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([]);
    const botId = await makeBot(h, "Fail closed Bot");
    const missing = await sendToBot(h, botId, "local.run:echo should-not-run");
    await waitThreadIdle(h, missing.threadId);
    const missingTranscript = await messages(h, missing.threadId);
    expect(toolNamed(missingTranscript, "local")?.toolCall?.status).toBe("error");
    expect(missingTranscript.some((message) => message.kind === "response" && message.text?.includes("should-not-run"))).toBeFalse();

    const hello = await sendToBot(h, botId, "say: hello");
    await waitThreadIdle(h, hello.threadId);
    expect((await messages(h, hello.threadId)).some((message) => message.kind === "response" && message.text?.includes("hello"))).toBeTrue();

    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect(toolNamed(await messages(h, native.threadId), "bash")?.toolCall?.status).toBe("completed");
  });

  test("This Device is the tagged sender, not whichever Sidecar is online", async () => {
    h = await startDaemon();
    const a = await connect();
    await a.register({ deviceId: DEVICE_A, hostname: "laptop-a", capabilities: ["shell"] });
    const b = await connect();
    await b.register({ deviceId: DEVICE_B, hostname: "laptop-b", capabilities: ["shell"] });
    const botId = await makeBot(h, "Tagged sender Bot");

    const untagged = await sendToBot(h, botId, "local.run:echo untagged");
    await waitThreadIdle(h, untagged.threadId);
    expect(toolNamed(await messages(h, untagged.threadId), "local")?.toolCall?.status).toBe("error");
    expect(a.jobs()).toEqual([]);
    expect(b.jobs()).toEqual([]);

    const pending = sendToBot(h, botId, "local.run:echo tagged", DEVICE_A);
    const job = await a.waitForJob();
    expect(job).toMatchObject({ action: "run", hostname: "laptop-a", command: "echo tagged" });
    expect(b.jobs()).toEqual([]);
    await a.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(a.executed).toEqual(["echo tagged"]);
    expect(b.executed).toEqual([]);

    const explicit = sendToBot(h, botId, `local.run@${DEVICE_B}:echo explicit`, DEVICE_A);
    const other = await b.waitForJob();
    expect(other.command).toBe("echo explicit");
    expect(a.jobs().map((candidate) => candidate.command)).toEqual(["echo tagged"]);
    await b.allowOnce();
    await waitThreadIdle(h, (await explicit).threadId);
    expect(b.executed).toEqual(["echo explicit"]);
  });

  test("unknown or disconnected device identities fail without running on another Sidecar", async () => {
    h = await startDaemon();
    const b = await connect();
    await b.register({ deviceId: DEVICE_B, hostname: "laptop-b", capabilities: ["shell"] });
    const botId = await makeBot(h, "Unknown device Bot");

    const unknown = await sendToBot(h, botId, `local.run@${DEVICE_A}:echo unknown-a`);
    await waitThreadIdle(h, unknown.threadId);
    expect(toolNamed(await messages(h, unknown.threadId), "local")?.toolCall?.status).toBe("error");
    expect(b.jobs()).toEqual([]);
    expect(b.executed).toEqual([]);

    const a = await connect();
    await a.register({ deviceId: DEVICE_A, hostname: "laptop-a", capabilities: ["shell"] });
    await a.close();
    await waitRoster(h, (devices) => devices.every((device) => device.id !== DEVICE_A));

    const offline = await sendToBot(h, botId, `local.run@${DEVICE_A}:echo disconnected-a`);
    await waitThreadIdle(h, offline.threadId);
    expect(toolNamed(await messages(h, offline.threadId), "local")?.toolCall?.status).toBe("error");
    expect(b.jobs()).toEqual([]);
    expect(b.executed).toEqual([]);
    expect(a.executed).toEqual([]);
  });

  test("disconnect during Ask fails the Tool Call and reconnect does not complete it", async () => {
    h = await startDaemon();
    const first = await connect();
    await first.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Drop mid job Bot");
    const pending = sendToBot(h, botId, "local.run:echo mid-job", DEVICE_A);
    await first.waitForJob();
    expect(first.executed).toEqual([]);
    await first.close();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    const failedTranscript = await messages(h, sent.threadId);
    expect(toolNamed(failedTranscript, "local")?.toolCall?.status).toBe("error");
    expect(failedTranscript.some((message) => message.kind === "response" && message.text?.includes("mid-job"))).toBeFalse();

    const replacement = await connect();
    await replacement.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    await Bun.sleep(200);
    expect(replacement.jobs()).toEqual([]);
    expect(replacement.executed).toEqual([]);
    expect(first.executed).toEqual([]);
    const afterReconnect = await messages(h, sent.threadId);
    expect(toolNamed(afterReconnect, "local")?.toolCall?.status).toBe("error");
    expect(afterReconnect.some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed")).toBeFalse();
  });

  test("native bash with a Sidecar online keeps Shared Workspace cwd and creates no sidecar jobs", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Native cwd Bot");
    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect(sidecar.jobs()).toEqual([]);
    expect(sidecar.executed).toEqual([]);
    expect(toolNamed(await messages(h, native.threadId), "bash")?.toolCall?.status).toBe("completed");
    const opened = workerObservations(h).find((observation) => observation.type === "session.open");
    expect(opened?.options?.cwd).toBe(h.svc.cfg.sharedWorkspaceDir);
    expect(h.svc.cfg.sharedWorkspaceDir).toBe(path.join(h.home, ".omarchy-bot", "workspace"));
  });

  test("computer screenshot with a Sidecar online still uses Bot Screen and creates no sidecar jobs", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Computer vs local Bot");
    const screen = await sendToBot(h, botId, "computer:screenshot");
    await waitThreadIdle(h, screen.threadId);
    expect(sidecar.jobs()).toEqual([]);
    expect(sidecar.executed).toEqual([]);
    expect(toolNamed(await messages(h, screen.threadId), "computer")?.toolCall?.name).toBe("computer");
    expect(toolNamed(await messages(h, screen.threadId), "local")).toBeUndefined();
  });
});
