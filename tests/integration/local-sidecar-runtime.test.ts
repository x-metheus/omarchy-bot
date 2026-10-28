import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sidecarMain = path.resolve(import.meta.dir, "../../apps/sidecar/src/main.ts");

/** A detached descendant that ignores SIGTERM and only writes its marker once released. */
const DESCENDANT_COMMAND = `sh -c 'trap "" TERM; echo $$ > descendant.pid; while [ ! -f release ]; do sleep 0.05; done; printf survived > marker.txt' & wait`;

/** Paired-device token; the Harness field may not be typed yet, so narrow at runtime. */
const pairedToken = (h: Harness): string => {
  if (!("token" in h) || typeof h.token !== "string") throw new Error("harness did not pair");
  return h.token;
};

const processAlive = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X";
  } catch {
    return false;
  }
};

/**
 * Real child processes run on real time: fake timers cannot advance a live
 * process's liveness, so the test polls OS state instead of guessing delays.
 */
const until = async (probe: () => boolean, message: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
};

/** Fail if the probe ever becomes true inside the window. */
const never = async (probe: () => boolean, message: string, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) throw new Error(message);
    if (Date.now() >= deadline) return;
    await Bun.sleep(20);
  }
};

describe("Local Sidecar process", () => {
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

  test.each(["http://127.0.0.1", "https://127.0.0.1", "ws://user:secret@127.0.0.1", "not-a-url"])("rejects invalid Service URL %s", async (service) => {
    const rejected = Bun.spawn({ cmd: [process.execPath, sidecarMain], stdout: "pipe", stderr: "pipe", env: { ...process.env, OMARCHY_BOT_SERVICE_URL: service } });
    expect(await rejected.exited).toBe(1);
    expect(await new Response(rejected.stdout).text()).not.toContain('"type":"registered"');
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
        OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${h.port}`,
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_DEVICE_TOKEN: pairedToken(h),
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
        os: process.platform === "darwin" ? "macos" : "linux",
        shell: "posix-sh",
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
        OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${h.port}`,
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_DEVICE_TOKEN: pairedToken(h),
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

  test.each(["shutdown", "cancel", "timeout"] as const)("%s tears down a running Sidecar process tree", async (trigger) => {
    h = await startDaemon();
    if (trigger === "timeout") h.svc.cfg.turnTimeoutMs = 3_000;
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sidecar-shutdown-"));
    // The remembered Always rule lets the job run without an Ask card.
    writeFileSync(
      path.join(root, ".omarchy-bot-local-policy.json"),
      JSON.stringify({ always: [`run:${DESCENDANT_COMMAND}`], never: [] }),
    );
    let stdout = "";
    const sidecar = Bun.spawn({
      cmd: [process.execPath, sidecarMain],
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${h.port}`,
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_DEVICE_TOKEN: pairedToken(h),
        OMARCHY_BOT_HOSTNAME: "shutdown-laptop",
        OMARCHY_BOT_SIDECAR_ROOT: root,
      },
    });
    child = sidecar;
    const stdoutStream = sidecar.stdout;
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
    await until(() => stdout.includes('"type":"registered"'), "production Local Sidecar never registered");

    const botId = await makeBot(h, "Shutdown Sidecar Bot");
    const sent = await sendToBot(h, botId, `local.run:${DESCENDANT_COMMAND}`, DEVICE_A);
    const pidFile = path.join(root, "descendant.pid");
    await until(() => existsSync(pidFile), "Sidecar descendant never became ready");
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isSafeInteger(pid)).toBeTrue();
    expect(processAlive(pid)).toBeTrue();

    try {
      if (trigger === "shutdown") {
        sidecar.kill("SIGTERM");
        await until(() => sidecar.exitCode !== null, "production Local Sidecar never exited after SIGTERM");
        child = undefined;
      } else {
        if (trigger === "cancel") await h.svc.turns.abortTurn(sent.turnId, "cancel process tree");
        await waitThreadIdle(h, sent.threadId);
        await until(() => !processAlive(pid), "cancelled or timed-out descendant survived");
      }

      expect(processAlive(pid)).toBeFalse();
      writeFileSync(path.join(root, "release"), "");
      // A survivor would write the marker within its poll interval, so watch for it.
      await never(() => existsSync(path.join(root, "marker.txt")), "descendant survived the Sidecar shutdown");
    } finally {
      if (processAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 40_000);
});
