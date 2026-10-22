import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("transfer files between Sidecar and Shared Workspace", () => {
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
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:from-laptop.txt:inbox/from-laptop.txt");
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

    const missing = await sendToBot(h, botId, "local.transfer:from-workspace:plugin-note.txt:");
    await waitThreadIdle(h, missing.threadId);
    expect((await messages(h, missing.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
    expect(existsSync(sidecar.sandboxPath("plugin-note.txt"))).toBeFalse();

    const pending = sendToBot(h, botId, "local.transfer:from-workspace:plugin-note.txt:downloads/plugin-note.txt");
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
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:from-laptop.txt:inbox/denied.txt");
    await sidecar.waitForJob();
    await sidecar.denyOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(existsSync(path.join(h.svc.cfg.sharedWorkspaceDir, "inbox/denied.txt"))).toBeFalse();
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });

  test("a transfer larger than the result frame settles instead of hanging", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["transfer"],
    });
    writeFileSync(sidecar.sandboxPath("big.txt"), "x".repeat(16_385));
    const botId = await makeBot(h, "Large transfer Bot");
    const pending = sendToBot(h, botId, "local.transfer:to-workspace:big.txt:inbox/big.txt");
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    const landed = path.join(h.svc.cfg.sharedWorkspaceDir, "inbox/big.txt");
    expect(existsSync(landed)).toBeFalse();
    const tool = (await messages(h, sent.threadId)).find((message) => message.kind === "tool" && message.toolCall?.name === "local");
    expect(tool?.toolCall?.status).toBe("error");
    expect(tool?.toolCall?.errorSummary).toContain("did not parse");
  });
});
