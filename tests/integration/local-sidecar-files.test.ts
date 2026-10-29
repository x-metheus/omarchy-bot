import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const sidecar = await LocalSidecarFixture.connect(h!.port, h!.token);
    sidecars.push(sidecar);
    return sidecar;
  }

  test("Ask then Allow once writes and reads inside the sandbox, not Shared Workspace", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" });
    const botId = await makeBot(h, "Sidecar files Bot");
    const pendingWrite = sendToBot(h, botId, "local.write:notes/doc.txt:hello-from-sidecar", DEVICE_A);
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

    const pendingRead = sendToBot(h, botId, "local.read:notes/doc.txt", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const read = await pendingRead;
    await waitThreadIdle(h, read.threadId);
    expect((await messages(h, read.threadId)).some((message) => message.text?.includes("hello-from-sidecar"))).toBeTrue();
  });

  test("search returns bounded path hits and refuses to scan /", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" });
    const botId = await makeBot(h, "Sidecar search Bot");
    const pendingWrite = sendToBot(h, botId, "local.write:notes/doc.txt:hello-from-sidecar", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    await waitThreadIdle(h, (await pendingWrite).threadId);

    const pendingSearch = sendToBot(h, botId, "local.search:hello-from-sidecar", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const searched = await pendingSearch;
    await waitThreadIdle(h, searched.threadId);
    const blob = JSON.stringify(await messages(h, searched.threadId));
    expect(blob).toContain("notes/doc.txt");
    expect(blob).toContain("hello-from-sidecar");
    expect(blob.includes("/etc/passwd")).toBeFalse();

    const root = await sendToBot(h, botId, "local.search:/", DEVICE_A);
    await waitThreadIdle(h, root.threadId);
    expect((await messages(h, root.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });

  test("host OS search excludes credential stores and explicit access is refused", async () => {
    const os = process.platform === "darwin" ? "macos" : "linux";
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "credential-laptop" });
    const macStores = ["Library/Keychains", "Library/Accounts", "Library/Application Support/com.apple.TCC"];
    const protectedDirs = [".ssh", ".gnupg", ".aws", ".config", ...(os === "macos" ? macStores : [])];
    for (const dir of [...new Set([...protectedDirs, ...macStores, "notes", "Library/Keychains-backup", "lIbRaRy/kEyChAiNs", ".SsH"])]) {
      mkdirSync(sidecar.sandboxPath(dir), { recursive: true });
      writeFileSync(sidecar.sandboxPath(`${dir}/entry.txt`), "credential-sentinel");
    }
    const botId = await makeBot(h, "Credential stores Bot");
    mkdirSync(h.svc.cfg.sharedWorkspaceDir, { recursive: true });
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "public.txt"), "public-sentinel");
    const run = async (text: string) => {
      const pending = sendToBot(h!, botId, text, DEVICE_A);
      await sidecar.waitForJob();
      await sidecar.allowOnce();
      const sent = await pending;
      await waitThreadIdle(h!, sent.threadId);
      const transcript = await messages(h!, sent.threadId);
      return { tool: transcript.find((message) => message.kind === "tool" && message.toolCall?.name === "local"), text: JSON.stringify(transcript) };
    };
    const search = await run("local.search:credential-sentinel");
    expect(search.tool?.toolCall?.status).toBe("completed");
    expect(search.text).toContain("notes/entry.txt");
    expect(search.text).toContain("Library/Keychains-backup/entry.txt");
    for (const dir of ["lIbRaRy/kEyChAiNs", ".SsH"]) {
      if (os === "linux") expect(search.text).toContain(`${dir}/entry.txt`);
      else {
        expect(search.text).not.toContain(`${dir}/entry.txt`);
        const read = await run(`local.read:${dir}/entry.txt`);
        expect(read.tool?.toolCall?.status).toBe("error");
        expect(read.text).toContain("refuses credential directories");
        expect((await run(`local.write:${dir}/new.txt:must-not-land`)).tool?.toolCall?.status).toBe("error");
        expect((await run(`local.transfer:to-workspace:${dir}/entry.txt:stolen-mixed.txt`)).tool?.toolCall?.status).toBe("error");
        expect((await run(`local.transfer:from-workspace:public.txt:${dir}/new.txt`)).tool?.toolCall?.status).toBe("error");
        expect(existsSync(sidecar.sandboxPath(`${dir}/new.txt`))).toBeFalse();
      }
    }
    for (const dir of protectedDirs) {
      expect(search.text).not.toContain(`${dir}/entry.txt`);
      if (os === "macos") expect((await run(`local.read:${dir}/entry.txt`)).tool?.toolCall?.status).toBe("error");
    }
    if (os === "linux") {
      for (const dir of macStores) expect(search.text).toContain(`${dir}/entry.txt`);
    } else {
      for (const command of [
        "local.write:Library/Keychains/new.txt:must-not-land",
        "local.transfer:to-workspace:Library/Keychains/entry.txt:stolen.txt",
        "local.transfer:from-workspace:public.txt:Library/Keychains/new.txt",
      ]) expect((await run(command)).tool?.toolCall?.status).toBe("error");
      expect(existsSync(sidecar.sandboxPath("Library/Keychains/new.txt"))).toBeFalse();
      expect(existsSync(path.join(h.svc.cfg.sharedWorkspaceDir, "stolen.txt"))).toBeFalse();
    }
    for (const command of ["echo screenshot", "echo pointer", "echo SWAYSOCK", "echo WAYLAND_DISPLAY"]) {
      expect((await run(`local.run:${command}`)).tool?.toolCall?.status).toBe("error");
    }
    if (os === "macos") {
      sidecar.autoAllow();
      for (const dir of ["lIbRaRy/kEyChAiNs", ".SsH"]) {
        await expect(h.svc.devices.execute({ action: "search", query: "credential-sentinel", path: dir }, { botId, turnId: "mixed-search", deviceId: DEVICE_A }, AbortSignal.timeout(5_000))).rejects.toThrow("refuses credential directories");
      }
    }
  }, 20_000);

  test("deny does not create the file", async () => {
    h = await startDaemon();
    const sidecar = await connect();
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop" });
    const botId = await makeBot(h, "Denied write Bot");
    const pending = sendToBot(h, botId, "local.write:secret.txt:must-not-land", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.denyOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(existsSync(sidecar.sandboxPath("secret.txt"))).toBeFalse();
    expect(sidecar.executed).toEqual([]);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();
  });
});
