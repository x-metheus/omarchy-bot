import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("same-host viewers have no This Device", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  test("an untagged viewer does not get local even when another Sidecar is online", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "other-laptop", capabilities: ["shell"] });
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

  test("an off-host fixture registers on loopback transport as a distinct machine", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port);
    sidecars.push(sidecar);
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "off-host-laptop",
      capabilities: ["shell"],
    });
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([{
      id: DEVICE_A,
      hostname: "off-host-laptop",
      online: true,
      capabilities: ["shell"],
    }]);

    const botId = await makeBot(h, "Off-host Bot");
    const pending = sendToBot(h, botId, "local.run:echo off-host", DEVICE_A);
    await sidecar.waitForJob();
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual(["echo off-host"]);
  });
});
