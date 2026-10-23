import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Always/Never per Omarchy Bot install", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  async function connect(): Promise<LocalSidecarFixture> {
    const sidecar = await LocalSidecarFixture.connect(h!.port);
    sidecars.push(sidecar);
    return sidecar;
  }

  test("Always skips a later matching Ask for that install", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    await sidecar.alwaysAllow("run:echo remembered-ok");
    const botId = await makeBot(h, "Always Bot");
    const sent = await sendToBot(h, botId, "local.run:echo remembered-ok", DEVICE_A);
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual(["echo remembered-ok"]);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed")).toBeTrue();
    expect(existsSync(path.join(sidecar.sandbox, ".omarchy-bot-local-policy.json"))).toBeTrue();
    expect(JSON.stringify(h.svc.devices.list())).not.toContain("remembered-ok");
  });

  test("Never fails the Tool Call without running and still permits Bot Computer and native tools", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    await sidecar.neverAllow("run:echo blocked");
    const botId = await makeBot(h, "Never Bot");
    const blocked = await sendToBot(h, botId, "local.run:echo blocked", DEVICE_A);
    await waitThreadIdle(h, blocked.threadId);
    expect(sidecar.executed).toEqual([]);
    expect((await messages(h, blocked.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();

    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect((await messages(h, native.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "bash")).toBeTrue();

    const screen = await sendToBot(h, botId, "computer:screenshot");
    await waitThreadIdle(h, screen.threadId);
    expect(sidecar.jobs().some((job) => job.action !== "run")).toBeFalse();
    expect((await messages(h, screen.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "computer")).toBeTrue();
  });

  test("Allow once does not persist as Always", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Once Bot");
    const first = sendToBot(h, botId, "local.run:echo once-only", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    await waitThreadIdle(h, (await first).threadId);
    expect(sidecar.executed).toEqual(["echo once-only"]);

    const second = sendToBot(h, botId, "local.run:echo once-only", DEVICE_A);
    const job = await sidecar.waitForJob();
    expect(job.command).toBe("echo once-only");
    expect(sidecar.executed).toEqual(["echo once-only"]);
    await sidecar.allowOnce(job.jobId);
    await waitThreadIdle(h, (await second).threadId);
    expect(sidecar.executed).toEqual(["echo once-only", "echo once-only"]);
  });

  test("denyOnce fails without a process", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Deny Bot");
    const pending = sendToBot(h, botId, "local.run:echo denied-now", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.denyOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual([]);
    expect(sidecar.denied.some((rule) => rule.includes("echo denied-now"))).toBeTrue();
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });

  test("cancelling the Turn during Ask dismisses the card and a late Allow does not run", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop", capabilities: ["shell"] });
    const botId = await makeBot(h, "Cancel Ask Bot");
    const pending = sendToBot(h, botId, "local.run:echo cancelled-ask", DEVICE_A);
    const job = await sidecar.waitForJob();
    const sent = await pending;
    await h.svc.turns.abortTurn(sent.turnId, "cancel during Ask");
    await sidecar.waitForFrame((frame) => frame.type === "local.cancel" && frame.jobId === job.jobId);
    await expect(sidecar.allowOnce(job.jobId)).rejects.toThrow("no Local Sidecar job waiting");

    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual([]);
    expect(existsSync(path.join(sidecar.sandbox, ".omarchy-bot-local-policy.json"))).toBeFalse();
    expect((await messages(h, sent.threadId)).find((message) => message.kind === "tool" && message.toolCall?.name === "local")?.toolCall?.status).not.toBe("completed");
  });
});
