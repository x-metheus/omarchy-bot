import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("outbound Local Sidecar device roster", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  async function boot(): Promise<Harness> {
    h = await startDaemon(undefined, { waitForAgentReady: false });
    return h;
  }

  async function connect(): Promise<LocalSidecarFixture> {
    const sidecar = await LocalSidecarFixture.connect(h!.port, h!.token);
    sidecars.push(sidecar);
    return sidecar;
  }

  test("lists no devices until an outbound Local Sidecar registers", async () => {
    const harness = await boot();
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([]);
  });

  test.each([
    { os: "linux", shell: "posix-sh" },
    { os: "macos", shell: "posix-sh" },
    { os: "windows", shell: "powershell-5.1" },
  ] as const)("registers hostname, OS, shell, and capabilities: %s", async (identity) => {
    const harness = await boot();
    const sidecar = await connect();
    const registered = await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      ...identity,
      capabilities: ["shell", "search", "files", "transfer"],
    });
    expect(registered).toEqual({ type: "registered", deviceId: DEVICE_A });
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([
      {
        id: DEVICE_A,
        hostname: "laptop",
        online: true,
        ...identity,
        capabilities: ["shell", "search", "files", "transfer"],
      },
    ]);
  });

  test("rejects missing or invalid OS and shell before listing a device", async () => {
    const harness = await boot();
    for (const identity of [{}, { os: "linux" }, { shell: "posix-sh" }, { os: "other", shell: "posix-sh" }, { os: "macos", shell: "bash" }]) {
      const sidecar = await connect();
      sidecar.send({ type: "register", deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"], ...identity });
      expect((await sidecar.waitForFrame((frame) => frame.type === "registered" || frame.type === "error")).type).toBe("error");
      expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([]);
      await sidecar.close();
    }
  });

  test("rejects screenshot and Takeover capabilities without listing the device", async () => {
    const harness = await boot();
    const sidecar = await connect();
    const rejected = await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell", "screenshot" as "shell"],
    });
    expect(rejected.type).toBe("error");
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([]);
  });

  test("stays on the roster after heartbeat and leaves after disconnect", async () => {
    const harness = await boot();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    sidecar.heartbeat();
    await Bun.sleep(50);
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toHaveLength(1);
    await sidecar.close();
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([]);
  });

  test("replaces a reconnecting device identity and keeps distinct machines separate", async () => {
    const harness = await boot();
    const first = await connect();
    await first.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    const replacement = await connect();
    await replacement.register({
      deviceId: DEVICE_A,
      hostname: "laptop-2",
      capabilities: ["shell", "files"],
    });
    await Bun.sleep(50);
    expect(first.closed).toBeTrue();
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toEqual([
      {
        id: DEVICE_A,
        hostname: "laptop-2",
        online: true,
        os: "linux", shell: "posix-sh",
        capabilities: ["shell", "files"],
      },
    ]);

    const other = await connect();
    await other.register({
      deviceId: DEVICE_B,
      hostname: "studio",
      capabilities: ["search"],
    });
    const roster = await api<DeviceDto[]>(harness, "GET", "/api/devices");
    expect(roster.map((device) => device.id).sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  test("keeps the device channel off the event stream", async () => {
    const harness = await boot();
    const events = new WebSocket(`ws://127.0.0.1:${harness.port}/api/events?access_token=${encodeURIComponent(harness.token)}`);
    const eventFrames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      events.addEventListener("open", () => resolve(), { once: true });
      events.addEventListener("error", () => reject(new Error("event stream failed")), { once: true });
    });
    events.addEventListener("message", (event) => eventFrames.push(String(event.data)));
    events.send(JSON.stringify({ type: "hello" }));

    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    await Bun.sleep(50);
    expect(eventFrames.some((frame) => frame.includes("register") || frame.includes(DEVICE_A))).toBeFalse();
    expect(await api<DeviceDto[]>(harness, "GET", "/api/devices")).toHaveLength(1);
    events.close();
  });
});


describe("approved local.run on this-device", () => {
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

  test("Ask holds the command until Allow once runs it in the Sidecar sandbox", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    const botId = await makeBot(h, "Local run Bot");
    const pending = sendToBot(h, botId, "local.run:echo sidecar-sentinel; pwd", DEVICE_A);
    const job = await sidecar.waitForJob();
    expect(job).toMatchObject({
      type: "local.job",
      action: "run",
      hostname: "laptop",
      command: "echo sidecar-sentinel; pwd",
    });
    expect(sidecar.executed).toEqual([]);
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual(["echo sidecar-sentinel; pwd"]);
    const transcript = await messages(h, sent.threadId);
    const tool = transcript.find((message) => message.kind === "tool" && message.toolCall?.name === "local");
    expect(tool?.toolCall?.target).toContain("laptop");
    expect(tool?.toolCall?.target).toContain("echo sidecar-sentinel; pwd");
    expect(transcript.some((message) => message.text?.includes("sidecar-sentinel"))).toBeTrue();
    expect(transcript.some((message) => message.text?.includes(sidecar.sandbox))).toBeTrue();
  });

  test("native bash stays on the plugin host while computer still uses Bot Screen", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    const botId = await makeBot(h, "Native vs local Bot");
    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect(sidecar.jobs()).toEqual([]);
    expect(sidecar.executed).toEqual([]);
    const nativeTranscript = await messages(h, native.threadId);
    expect(nativeTranscript.some((message) => message.kind === "tool" && message.toolCall?.name === "bash")).toBeTrue();

    const screen = await sendToBot(h, botId, "computer:screenshot");
    await waitThreadIdle(h, screen.threadId);
    expect(sidecar.jobs()).toEqual([]);
    const screenTranscript = await messages(h, screen.threadId);
    expect(screenTranscript.some((message) => message.kind === "tool" && message.toolCall?.name === "computer")).toBeTrue();
  });

  test("local.run without an online Sidecar fails closed and does not spawn", async () => {
    h = await startDaemon();
    const botId = await makeBot(h, "No sidecar Bot");
    const sent = await sendToBot(h, botId, "local.run:echo should-not-run");
    await waitThreadIdle(h, sent.threadId);
    const transcript = await messages(h, sent.threadId);
    expect(transcript.some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
    expect(transcript.some((message) => message.kind === "response" && message.text?.includes("should-not-run"))).toBeFalse();
  });

  test("command output is bounded and redacts obvious credentials", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    });
    const botId = await makeBot(h, "Redacted local Bot");
    const pending = sendToBot(h, botId, "local.run:echo token=supersecret", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    const transcript = await messages(h, sent.threadId);
    const botBlob = JSON.stringify(transcript.filter((message) => message.author.kind === "bot"));
    expect(botBlob).not.toContain("supersecret");
    expect(botBlob).toContain("[redacted]");
  });
});
