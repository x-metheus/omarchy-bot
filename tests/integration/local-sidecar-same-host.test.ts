import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("same-host viewers have no This Device", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];
  const machineIdOverride = process.env.OMARCHY_BOT_MACHINE_ID_FILE;
  let identityDirectory: string | undefined;

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
    if (machineIdOverride === undefined) delete process.env.OMARCHY_BOT_MACHINE_ID_FILE;
    else process.env.OMARCHY_BOT_MACHINE_ID_FILE = machineIdOverride;
    if (identityDirectory) rmSync(identityDirectory, { recursive: true, force: true });
  });

  test("an untagged viewer does not get local even when another Sidecar is online", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "other-laptop" });
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toHaveLength(1);

    const botId = await makeBot(h, "Viewer Bot");
    const local = await sendToBot(h, botId, "local.run:echo viewer-must-not-run");
    await waitThreadIdle(h, local.threadId);
    expect(sidecar.jobs()).toEqual([]);
    expect(sidecar.executed).toEqual([]);
    const localTranscript = await messages(h, local.threadId);
    expect(localTranscript.some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();

    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect((await messages(h, native.threadId)).some((message) => message.kind === "tool" && message.toolCall?.name === "bash")).toBeTrue();
    const agents = await api<{ id: string; status: string }[]>(h, "GET", "/api/agents");
    expect(agents.find((agent) => agent.id === "pi")?.status).toBe("ready");
  });

  test("a distinct host over a loopback tunnel approves local.run on the client machine", async () => {
    identityDirectory = mkdtempSync(path.join(os.tmpdir(), "sidecar-host-"));
    const serviceMachineId = "0123456789abcdef0123456789abcdef";
    const clientMachineId = "fedcba9876543210fedcba9876543210";
    const identityFile = path.join(identityDirectory, "service-machine-id");
    writeFileSync(identityFile, `${serviceMachineId}\n`);
    process.env.OMARCHY_BOT_MACHINE_ID_FILE = identityFile;
    h = await startDaemon();
    const identity = await api<{ salt: string; digest: string }>(h, "GET", "/api/host-identity");
    expect(identity.digest).toBe(createHash("sha256").update(`${identity.salt}:${serviceMachineId}`).digest("hex"));
    expect(identity.digest).not.toBe(createHash("sha256").update(`${identity.salt}:${clientMachineId}`).digest("hex"));
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "off-host-laptop" });
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([{
      id: DEVICE_A,
      hostname: "off-host-laptop",
      online: true,
      os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
      shell: process.platform === "win32" ? "powershell-5.1" : "posix-sh",
      capabilities: ["shell", "search", "files", "transfer"],
    }]);

    const botId = await makeBot(h, "Off-host Bot");
    const pending = sendToBot(h, botId, "local.run:printf client-machine > client-proof", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual(["printf client-machine > client-proof"]);
    expect(readFileSync(sidecar.sandboxPath("client-proof"), "utf8")).toBe("client-machine");
  });
});
