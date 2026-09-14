import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("search, read, and write on the Sidecar", () => {
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

  test("Ask then Allow once writes and reads inside the sandbox, not Shared Workspace", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["search", "files"],
    });
    const botId = await makeBot(h, "Sidecar files Bot");
    const pendingWrite = sendToBot(h, botId, "local.write:notes/doc.txt:hello-from-sidecar");
    const job = await sidecar.waitForJob();
    expect(job).toMatchObject({ action: "write", hostname: "laptop", path: "notes/doc.txt" });
    expect(sidecar.executed).toEqual([]);
    expect(existsSync(sidecar.sandboxPath("notes/doc.txt"))).toBeFalse();
    await sidecar.allowOnce();
    const written = await pendingWrite;
    await waitThreadIdle(h, written.threadId);
    expect(sidecar.executed).toEqual(["write:notes/doc.txt"]);
    expect(readFileSync(sidecar.sandboxPath("notes/doc.txt"), "utf8")).toBe("hello-from-sidecar");
    expect(existsSync(path.join(h.svc.cfg.sharedWorkspaceDir, "notes/doc.txt"))).toBeFalse();
    const writeTool = (await messages(h, written.threadId)).find((message) => message.kind === "tool" && message.toolCall?.name === "local");
    expect(writeTool?.toolCall?.target).toContain("laptop");
    expect(writeTool?.toolCall?.target).toContain("notes/doc.txt");

    const pendingRead = sendToBot(h, botId, "local.read:notes/doc.txt");
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const read = await pendingRead;
    await waitThreadIdle(h, read.threadId);
    expect((await messages(h, read.threadId)).some((message) => message.text?.includes("hello-from-sidecar"))).toBeTrue();
  });

  test("search returns bounded path hits and refuses to scan /", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["search", "files"],
    });
    const botId = await makeBot(h, "Sidecar search Bot");
    const pendingWrite = sendToBot(h, botId, "local.write:notes/doc.txt:hello-from-sidecar");
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    await waitThreadIdle(h, (await pendingWrite).threadId);

    const pendingSearch = sendToBot(h, botId, "local.search:hello-from-sidecar");
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const searched = await pendingSearch;
    await waitThreadIdle(h, searched.threadId);
    const blob = JSON.stringify(await messages(h, searched.threadId));
    expect(blob).toContain("notes/doc.txt");
    expect(blob).toContain("hello-from-sidecar");
    expect(blob.includes("/etc/passwd")).toBeFalse();

    const root = await sendToBot(h, botId, "local.search:/");
    await waitThreadIdle(h, root.threadId);
    expect((await messages(h, root.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });

  test("deny does not create the file", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "laptop",
      capabilities: ["files"],
    });
    const botId = await makeBot(h, "Denied write Bot");
    const pending = sendToBot(h, botId, "local.write:secret.txt:must-not-land");
    await sidecar.waitForJob();
    await sidecar.denyOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(existsSync(sidecar.sandboxPath("secret.txt"))).toBeFalse();
    expect(sidecar.executed).toEqual([]);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });
});
