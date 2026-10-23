import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sidecarMain = path.resolve(import.meta.dir, "../../apps/sidecar/src/main.ts");

describe("plugin-runtime Bun Local Sidecar", () => {
  let h: Harness | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  afterEach(async () => {
    if (child !== undefined) {
      child.kill("SIGKILL");
      await Promise.race([child.exited, Bun.sleep(500)]);
      child = undefined;
    }
    await h?.stop();
    h = undefined;
  });

  test("outbound production Sidecar registers, asks, runs, and unregisters without stopping plugin-host work", async () => {
    h = await startDaemon();
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sidecar-runtime-"));
    let stdout = "";
    child = Bun.spawn({
      cmd: [process.execPath, sidecarMain],
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OMARCHY_BOT_DAEMON_PORT: String(h.port),
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_HOSTNAME: "runtime-laptop",
        OMARCHY_BOT_SIDECAR_ROOT: root,
      },
    });
    const decoder = new TextDecoder();
    const stdoutStream = child.stdout;
    if (stdoutStream === undefined || typeof stdoutStream === "number") {
      throw new Error("production Local Sidecar stdout is not a pipe");
    }
    void (async () => {
      const reader = stdoutStream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += decoder.decode(value);
      }
    })();

    const registeredDeadline = Date.now() + 8_000;
    while (!stdout.includes('"type":"registered"')) {
      if (Date.now() > registeredDeadline) throw new Error("production Local Sidecar never registered");
      await Bun.sleep(20);
    }
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([
      {
        id: DEVICE_A,
        hostname: "runtime-laptop",
        online: true,
        capabilities: ["shell", "search", "files", "transfer"],
      },
    ]);

    const botId = await makeBot(h, "Runtime Sidecar Bot");
    const pending = sendToBot(h, botId, "local.run:echo runtime-sidecar", DEVICE_A);
    const askDeadline = Date.now() + 8_000;
    while (!stdout.includes('"type":"ask"')) {
      if (Date.now() > askDeadline) throw new Error("production Local Sidecar never asked");
      await Bun.sleep(20);
    }
    const ask = stdout.split("\n").map((line) => {
      try {
        return JSON.parse(line) as { type?: string; jobId?: string; hostname?: string; command?: string };
      } catch {
        return undefined;
      }
    }).find((frame) => frame?.type === "ask");
    expect(ask?.hostname).toBe("runtime-laptop");
    expect(ask?.command).toBe("echo runtime-sidecar");
    const stdin = child.stdin;
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("production Local Sidecar stdin is not a pipe");
    }
    stdin.write(`${JSON.stringify({ type: "allow-once", jobId: ask?.jobId })}\n`);
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    const transcript = await messages(h, sent.threadId);
    expect(transcript.some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed")).toBeTrue();
    expect(transcript.some((message) => message.text?.includes("runtime-sidecar"))).toBeTrue();

    child.kill();
    await child.exited;
    child = undefined;
    const emptyDeadline = Date.now() + 5_000;
    while ((await api<DeviceDto[]>(h, "GET", "/api/devices")).length > 0) {
      if (Date.now() > emptyDeadline) throw new Error("closed Local Sidecar stayed on the roster");
      await Bun.sleep(20);
    }

    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect((await messages(h, native.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "bash")).toBeTrue();
  }, 20_000);

  test("a Sidecar with no heartbeat for 30 s goes offline and its job fails", async () => {
    h = await startDaemon();
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sidecar-heartbeat-"));
    let stdout = "";
    child = Bun.spawn({
      cmd: [process.execPath, sidecarMain],
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OMARCHY_BOT_DAEMON_PORT: String(h.port),
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_HOSTNAME: "stale-laptop",
        OMARCHY_BOT_SIDECAR_ROOT: root,
      },
    });
    const stdoutStream = child.stdout;
    if (stdoutStream === undefined || typeof stdoutStream === "number") throw new Error("stdout is not a pipe");
    const decoder = new TextDecoder();
    void (async () => {
      const reader = stdoutStream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += decoder.decode(value);
      }
    })();
    const registeredDeadline = Date.now() + 8_000;
    while (!stdout.includes('"type":"registered"')) {
      if (Date.now() > registeredDeadline) throw new Error("Sidecar never registered");
      await Bun.sleep(20);
    }
    child.kill("SIGSTOP");
    const botId = await makeBot(h, "Stale Sidecar Bot");
    const pending = sendToBot(h, botId, "local.run:echo stale", DEVICE_A);
    const sent = await pending;
    const emptyDeadline = Date.now() + 45_000;
    while ((await api<DeviceDto[]>(h, "GET", "/api/devices")).length > 0) {
      if (Date.now() > emptyDeadline) throw new Error("silent Sidecar stayed online");
      await Bun.sleep(200);
    }
    await waitThreadIdle(h, sent.threadId, 20_000);
    const tool = (await messages(h, sent.threadId)).find((message) => message.kind === "tool" && message.toolCall?.name === "local");
    expect(tool?.toolCall?.status).toBe("error");
    expect(existsSync(path.join(root, ".omarchy-bot-local-policy.json"))).toBeFalse();
  }, 70_000);
});
