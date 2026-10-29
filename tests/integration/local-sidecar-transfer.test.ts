import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_RESULT_TEXT_MAX } from "../../packages/protocol/src/index.ts";
import { makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";
import { sidecarCommand } from "./helpers/sidecarCommand.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Paired-device token; the Harness field may not be typed yet, so narrow at runtime. */
const pairedToken = (h: Harness): string => {
  if (!("token" in h) || typeof h.token !== "string") throw new Error("harness did not pair");
  return h.token;
};

describe("transfer files between Sidecar and Shared Workspace", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];
  let child: Bun.Subprocess | undefined;

  afterEach(async () => {
    if (child !== undefined) {
      child.kill();
      await child.exited;
      child = undefined;
    }
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  async function connect(): Promise<LocalSidecarFixture> {
    const sidecar = await LocalSidecarFixture.connect(h!.port, h!.token);
    sidecars.push(sidecar);
    return sidecar;
  }

  test("copies a sentinel from the Sidecar into Shared Workspace", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["files", "transfer"],
    });
    writeFileSync(sidecar.sandboxPath("from-laptop.txt"), "sidecar-sentinel");
    const botId = await makeBot(h, "Transfer in Bot");
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:from-laptop.txt:inbox/from-laptop.txt", DEVICE_A);
    const job = await sidecar.waitForJob();
    expect(job).toMatchObject({
      action: "transfer",
      hostname: "laptop",
      direction: "to-workspace",
      path: "from-laptop.txt",
      destination: "inbox/from-laptop.txt",
    });
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    const landed = path.join(h.svc.cfg.sharedWorkspaceDir, "inbox/from-laptop.txt");
    expect(readFileSync(landed, "utf8")).toBe("sidecar-sentinel");
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed")).toBeTrue();
  });

  test("copies a Shared Workspace file onto the Sidecar only with an explicit destination", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["files", "transfer"],
    });
    mkdirSync(h.svc.cfg.sharedWorkspaceDir, { recursive: true });
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "plugin-note.txt"), "workspace-sentinel");
    const botId = await makeBot(h, "Transfer out Bot");

    const missing = await sendToBot(h, botId, "local.transfer:from-workspace:plugin-note.txt:", DEVICE_A);
    await waitThreadIdle(h, missing.threadId);
    expect((await messages(h, missing.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
    expect(existsSync(sidecar.sandboxPath("plugin-note.txt"))).toBeFalse();

    const pending = sendToBot(h, botId, "local.transfer:from-workspace:plugin-note.txt:downloads/plugin-note.txt", DEVICE_A);
    const job = await sidecar.waitForJob();
    expect(job.destination).toBe("downloads/plugin-note.txt");
    expect(job.hostname).toBe("laptop");
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(readFileSync(sidecar.sandboxPath("downloads/plugin-note.txt"), "utf8")).toBe("workspace-sentinel");
    expect(existsSync(path.join(h.home, "downloads/plugin-note.txt"))).toBeFalse();
  });

  test("deny does not copy bytes", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["transfer"],
    });
    writeFileSync(sidecar.sandboxPath("from-laptop.txt"), "sidecar-sentinel");
    const botId = await makeBot(h, "Denied transfer Bot");
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:from-laptop.txt:inbox/denied.txt", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.denyOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(existsSync(path.join(h.svc.cfg.sharedWorkspaceDir, "inbox/denied.txt"))).toBeFalse();
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });

  test("a transfer larger than the result frame settles instead of hanging", async () => {
    h = await startDaemon();
    const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sidecar-transfer-"));
    writeFileSync(path.join(root, "big.txt"), "x".repeat(LOCAL_RESULT_TEXT_MAX + 1));
    let stdout = "";
    child = Bun.spawn({
      cmd: sidecarCommand,
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OMARCHY_BOT_SERVICE_URL: `ws://127.0.0.1:${h.port}`,
        OMARCHY_BOT_DEVICE_ID: DEVICE_A,
        OMARCHY_BOT_DEVICE_TOKEN: pairedToken(h),
        OMARCHY_BOT_HOSTNAME: "laptop",
        OMARCHY_BOT_SIDECAR_ROOT: root,
      },
    });
    const stdoutStream = child.stdout;
    if (stdoutStream === undefined || typeof stdoutStream === "number") {
      throw new Error("production Local Sidecar stdout is not a pipe");
    }
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
      if (Date.now() > registeredDeadline) throw new Error("production Sidecar did not register");
      await Bun.sleep(20);
    }
    const botId = await makeBot(h, "Large transfer Bot");
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:big.txt:inbox/big.txt", DEVICE_A);
    const askDeadline = Date.now() + 8_000;
    while (!stdout.includes('"type":"ask"')) {
      if (Date.now() > askDeadline) throw new Error("production Sidecar did not ask");
      await Bun.sleep(20);
    }
    const ask = stdout.split("\n").map((line) => {
      try { return JSON.parse(line) as { type?: string; jobId?: string }; } catch { return undefined; }
    }).find((frame) => frame?.type === "ask");
    const stdin = child.stdin;
    if (stdin === undefined || typeof stdin === "number" || ask?.jobId === undefined) {
      throw new Error("production Local Sidecar did not ask with a writable stdin");
    }
    stdin.write(`${JSON.stringify({ type: "allow-once", jobId: ask.jobId })}\n`);
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(existsSync(path.join(h.svc.cfg.sharedWorkspaceDir, "inbox/big.txt"))).toBeFalse();
    const tool = (await messages(h, sent.threadId)).find((message) => message.kind === "tool" && message.toolCall?.name === "local");
    expect(tool?.toolCall?.status).toBe("error");
    expect(tool?.toolCall?.errorSummary).toContain("exceeds the");
  }, 20_000);
});
