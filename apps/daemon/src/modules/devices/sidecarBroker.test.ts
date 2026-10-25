import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeviceLocalJobFrame, DeviceServerFrame } from "@omarchy-bot/protocol";
import { SidecarBroker, type DevicePort } from "./sidecarBroker.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALL_CAPABILITIES = ["shell", "search", "files", "transfer"] as const;

class RecordingPort implements DevicePort {
  readonly frames: DeviceServerFrame[] = [];
  closed: { code?: number; reason?: string } | undefined;
  readonly #jobs: DeviceLocalJobFrame[] = [];
  readonly #jobWaiters: Array<(job: DeviceLocalJobFrame) => void> = [];

  send(frame: DeviceServerFrame): void {
    this.frames.push(frame);
    if (frame.type !== "local.job") return;
    const waiter = this.#jobWaiters.shift();
    if (waiter === undefined) this.#jobs.push(frame);
    else waiter(frame);
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }

  jobs(): DeviceLocalJobFrame[] {
    return this.frames.filter((frame): frame is DeviceLocalJobFrame => frame.type === "local.job");
  }

  /** Each call resolves with the next job this port has not yet handed out. */
  waitForJob(): Promise<DeviceLocalJobFrame> {
    const queued = this.#jobs.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const { promise, resolve } = Promise.withResolvers<DeviceLocalJobFrame>();
    this.#jobWaiters.push(resolve);
    return promise;
  }
}

const brokers: SidecarBroker[] = [];

function newBroker(now?: () => number): SidecarBroker {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-broker-"));
  const broker = new SidecarBroker(root, now);
  brokers.push(broker);
  return broker;
}

function register(broker: SidecarBroker, port: DevicePort, deviceId = DEVICE_A, capabilities: Array<"shell" | "search" | "files" | "transfer"> = [...ALL_CAPABILITIES]): void {
  const result = broker.register(port, { type: "register", deviceId, hostname: `host-${deviceId.slice(-1)}`, capabilities: [...capabilities] });
  expect(result.ok).toBeTrue();
}

const context = { botId: "bot_1", turnId: "turn_1", deviceId: DEVICE_A };

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close();
});

describe("SidecarBroker cancel", () => {
  test("aborting a pending job sends local.cancel and rejects it", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    expect(broker.register(port, {
      type: "register",
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["shell"],
    }).ok).toBeTrue();
    const controller = new AbortController();
    const pending = broker.execute(
      { action: "run", command: "echo sidecar" },
      { botId: "bot_1", turnId: "turn_1", deviceId: DEVICE_A },
      controller.signal,
    );
    const job = await port.waitForJob();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(port.frames).toContainEqual({ type: "local.cancel", jobId: job.jobId });
  });

  test("an already-aborted signal never dispatches the job", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port);
    await expect(broker.execute(
      { action: "run", command: "echo sidecar" },
      context,
      AbortSignal.abort(),
    )).rejects.toThrow();
    expect(port.frames).toEqual([]);
  });

  test("abort between result and workspace write sends local.cancel and writes nothing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-"));
    const broker = new SidecarBroker(root);
    brokers.push(broker);
    const port = new RecordingPort();
    register(broker, port);
    const controller = new AbortController();
    const pending = broker.execute(
      { action: "transfer", path: "remote.bin", destination: "incoming/remote.bin", direction: "to-workspace" },
      context,
      controller.signal,
    );
    const job = await port.waitForJob();
    broker.complete(port, DEVICE_A, { type: "local.result", jobId: job.jobId, ok: true, text: "payload" });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(existsSync(path.join(root, "incoming/remote.bin"))).toBeFalse();
    expect(port.frames).toContainEqual({ type: "local.cancel", jobId: job.jobId });
  });
});

describe("SidecarBroker roster", () => {
  test("register validates the frame and lists online DTOs", () => {
    const broker = newBroker();
    const port = new RecordingPort();
    expect(broker.register(port, { type: "register", deviceId: "nope", hostname: "laptop", capabilities: ["shell"] }).ok).toBeFalse();
    expect(broker.register(port, { type: "heartbeat" }).ok).toBeFalse();
    expect(broker.list()).toEqual([]);

    register(broker, port);
    expect(broker.list()).toEqual([{ id: DEVICE_A, hostname: "host-a", online: true, capabilities: [...ALL_CAPABILITIES] }]);
    expect(broker.get(DEVICE_A)?.online).toBeTrue();
    expect(broker.get(DEVICE_B)).toBeUndefined();
  });

  test("disconnect only drops the current port", () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port);
    broker.disconnect(new RecordingPort(), DEVICE_A);
    expect(broker.get(DEVICE_A)).toBeDefined();
    broker.disconnect(port, DEVICE_A);
    expect(broker.get(DEVICE_A)).toBeUndefined();
  });

  test("replacement closes the old port and fails its jobs", async () => {
    const broker = newBroker();
    const first = new RecordingPort();
    register(broker, first);
    const pending = broker.execute({ action: "run", command: "echo sidecar" }, context, new AbortController().signal);
    await first.waitForJob();

    const second = new RecordingPort();
    register(broker, second);
    expect(first.closed?.code).toBe(4000);
    await expect(pending).rejects.toThrow();
    expect(broker.list()).toHaveLength(1);
  });

  test("a result from the wrong port is ignored", async () => {
    const broker = newBroker();
    const portA = new RecordingPort();
    const portB = new RecordingPort();
    register(broker, portA, DEVICE_A);
    register(broker, portB, DEVICE_B);
    const pending = broker.execute({ action: "run", command: "echo sidecar" }, context, new AbortController().signal);
    const job = await portA.waitForJob();

    broker.complete(portB, DEVICE_B, { type: "local.result", jobId: job.jobId, ok: true, text: "wrong" });
    broker.complete(portA, DEVICE_B, { type: "local.result", jobId: job.jobId, ok: true, text: "wrong" });
    broker.complete(portA, DEVICE_A, { type: "local.result", jobId: job.jobId, ok: true, text: "right" });
    expect((await pending).text).toBe("right");
  });

  test("a malformed local.result rejects that job", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port);
    const pending = broker.execute({ action: "run", command: "echo sidecar" }, context, new AbortController().signal);
    const job = await port.waitForJob();
    broker.complete(port, DEVICE_A, { type: "local.result", jobId: job.jobId });
    await expect(pending).rejects.toThrow(/did not parse/);
  });

  test("capability and root-search checks happen before dispatch", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port, DEVICE_A, ["shell"]);
    await expect(broker.execute({ action: "read", path: "notes.txt" }, context, new AbortController().signal)).rejects.toThrow();
    register(broker, new RecordingPort(), DEVICE_B);
    await expect(broker.execute({ action: "search", query: "x", path: "/" }, { ...context, deviceId: DEVICE_B }, new AbortController().signal)).rejects.toThrow();
    expect(port.frames).toEqual([]);
  });
});

describe("SidecarBroker This Device", () => {
  test("untagged and unknown turns fail closed", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port);
    await expect(broker.execute({ action: "run", command: "echo" }, { botId: "bot_1", turnId: "turn_1" }, new AbortController().signal)).rejects.toThrow();
    await expect(broker.execute({ action: "run", command: "echo" }, { ...context, deviceId: DEVICE_B }, new AbortController().signal)).rejects.toThrow();
    expect(port.frames).toEqual([]);
  });

  test("the tagged device wins and an explicit target may name another online device", async () => {
    const broker = newBroker();
    const portA = new RecordingPort();
    const portB = new RecordingPort();
    register(broker, portA, DEVICE_A);
    register(broker, portB, DEVICE_B);

    const pending = broker.execute({ action: "run", command: "echo this" }, context, new AbortController().signal);
    expect((await portA.waitForJob()).hostname).toBe("host-a");
    expect(portB.jobs()).toHaveLength(0);
    const job = portA.jobs()[0]!;
    broker.complete(portA, DEVICE_A, { type: "local.result", jobId: job.jobId, ok: true, text: "this" });
    await pending;

    const other = broker.execute({ action: "run", command: "echo other", target: DEVICE_B }, context, new AbortController().signal);
    const otherJob = await portB.waitForJob();
    expect(otherJob.hostname).toBe("host-b");
    broker.complete(portB, DEVICE_B, { type: "local.result", jobId: otherJob.jobId, ok: true, text: "other" });
    expect((await other).deviceId).toBe(DEVICE_B);
  });
});

describe("SidecarBroker workspace transfer bounds", () => {
  test("an oversized from-workspace source is rejected before dispatch", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-"));
    const broker = new SidecarBroker(root);
    brokers.push(broker);
    const port = new RecordingPort();
    register(broker, port);
    mkdirSync(path.join(root, "outgoing"), { recursive: true });
    writeFileSync(path.join(root, "outgoing/big.bin"), "x".repeat(65_537));

    const pending = broker.execute(
      { action: "transfer", path: "outgoing/big.bin", destination: "/tmp/big.bin", direction: "from-workspace" },
      context,
      new AbortController().signal,
    );
    pending.catch(() => {});
    expect(port.frames).toEqual([]);
    await expect(pending).rejects.toThrow(/contents is 65537 characters, limit is 65536/);
  });

  test("a 65536-character from-workspace source still dispatches in full", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-"));
    const broker = new SidecarBroker(root);
    brokers.push(broker);
    const port = new RecordingPort();
    register(broker, port);
    mkdirSync(path.join(root, "outgoing"), { recursive: true });
    writeFileSync(path.join(root, "outgoing/edge.bin"), "y".repeat(65_536));

    const pending = broker.execute(
      { action: "transfer", path: "outgoing/edge.bin", destination: "/tmp/edge.bin", direction: "from-workspace" },
      context,
      new AbortController().signal,
    );
    const job = await port.waitForJob();
    expect(job.contents).toHaveLength(65_536);
    broker.complete(port, DEVICE_A, { type: "local.result", jobId: job.jobId, ok: true, text: "ok" });
    expect((await pending).text).toBe("ok");
  });
});

describe("SidecarBroker liveness", () => {
  test("30 s without heartbeat makes the device offline and fails its jobs; heartbeats keep a job alive", async () => {
    let clock = 0;
    const broker = newBroker(() => clock);
    const port = new RecordingPort();
    register(broker, port);
    const pending = broker.execute({ action: "run", command: "sleep 600" }, context, new AbortController().signal);
    await port.waitForJob();

    clock = 20_000;
    broker.heartbeat(port, DEVICE_A);
    clock = 39_999;
    broker.expire();
    expect(broker.get(DEVICE_A)).toBeDefined();
    expect(port.closed).toBeUndefined();

    clock = 50_000;
    broker.expire();
    expect(broker.list()).toEqual([]);
    expect(port.closed?.code).toBe(4001);
    await expect(pending).rejects.toThrow(/heartbeat/);
  });
});

describe("SidecarBroker output", () => {
  test("non-transfer output is redacted and sliced to 8192", async () => {
    const broker = newBroker();
    const port = new RecordingPort();
    register(broker, port);
    const pending = broker.execute({ action: "run", command: "env" }, context, new AbortController().signal);
    const job = await port.waitForJob();
    broker.complete(port, DEVICE_A, {
      type: "local.result",
      jobId: job.jobId,
      ok: true,
      text: `token=abc123 Bearer xyz ${"a".repeat(64)} ${"x".repeat(12_000)}`,
    });
    const result = await pending;
    expect(result.text.startsWith("token=[redacted] Bearer [redacted] [redacted] ")).toBeTrue();
    expect(result.text).toHaveLength(8_192);
  });

  test("transfer text reaches the workspace intact and reads from it through confinedPath", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-"));
    const broker = new SidecarBroker(root);
    brokers.push(broker);
    const port = new RecordingPort();
    register(broker, port);

    const incoming = broker.execute(
      { action: "transfer", path: "remote.bin", destination: "incoming/remote.bin", direction: "to-workspace" },
      context,
      new AbortController().signal,
    );
    const incomingJob = await port.waitForJob();
    const payload = "token=abc123 not redacted for transfer";
    broker.complete(port, DEVICE_A, { type: "local.result", jobId: incomingJob.jobId, ok: true, text: payload });
    expect((await incoming).text).toBe(payload);
    expect(readFileSync(path.join(root, "incoming/remote.bin"), "utf8")).toBe(payload);

    mkdirSync(path.join(root, "outgoing"), { recursive: true });
    writeFileSync(path.join(root, "outgoing/local.bin"), "from workspace");
    const outgoing = broker.execute(
      { action: "transfer", path: "outgoing/local.bin", destination: "/tmp/local.bin", direction: "from-workspace" },
      context,
      new AbortController().signal,
    );
    const outgoingJob = await port.waitForJob();
    expect(outgoingJob.contents).toBe("from workspace");
    broker.complete(port, DEVICE_A, { type: "local.result", jobId: outgoingJob.jobId, ok: true, text: "ok" });
    expect((await outgoing).text).toBe("ok");

    await expect(broker.execute(
      { action: "transfer", path: "../escape", destination: "/tmp/x", direction: "from-workspace" },
      context,
      new AbortController().signal,
    )).rejects.toThrow();
  });
});
