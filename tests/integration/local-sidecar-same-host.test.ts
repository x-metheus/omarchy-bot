import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDto } from "../../packages/protocol/src/index.ts";
import { shouldStartLocalSidecar } from "../../packages/protocol/src/index.ts";
import { api, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("skip Local Sidecar when connected to this plugin daemon", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  test("a same-host Omarchy Bot viewer does not register a Sidecar or offer local", async () => {
    h = await startDaemon();
    const skip = shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "127.0.0.1",
      daemonPort: h.port,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: h.port,
    });
    expect(skip).toBeFalse();
    expect(shouldStartLocalSidecar({
      clientKind: "web",
      daemonHost: "127.0.0.1",
      daemonPort: h.port,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: h.port,
    })).toBeFalse();
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([]);

    const botId = await makeBot(h, "Viewer Bot");
    const local = await sendToBot(h, botId, "local.run:echo viewer-must-not-run");
    await waitThreadIdle(h, local.threadId);
    const localTranscript = await messages(h, local.threadId);
    expect(localTranscript.some((message) => message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error")).toBeTrue();

    const native = await sendToBot(h, botId, "tool");
    await waitThreadIdle(h, native.threadId);
    expect(await messages(h, native.threadId).then((rows) => rows.some((message) => message.kind === "tool" && message.toolCall?.name === "bash"))).toBeTrue();
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([]);
    const agents = await api<{ id: string; status: string }[]>(h, "GET", "/api/agents");
    expect(agents.find((agent) => agent.id === "pi")?.status).toBe("ready");
  });

  test("an off-host fixture still registers on loopback transport as a distinct machine", async () => {
    h = await startDaemon();
    const start = shouldStartLocalSidecar({
      clientKind: "omarchy-bot",
      daemonHost: "127.0.0.1",
      daemonPort: h.port + 1,
      thisDaemonHost: "127.0.0.1",
      thisDaemonPort: h.port,
    });
    expect(start).toBeTrue();
    const sidecar = await LocalSidecarFixture.connect(h.port);
    sidecars.push(sidecar);
    await sidecar.register({
      deviceId: DEVICE_A,
      hostname: "off-host-laptop",
      capabilities: ["shell"],
    });
    expect(await api<DeviceDto[]>(h, "GET", "/api/devices")).toEqual([
      {
        id: DEVICE_A,
        hostname: "off-host-laptop",
        online: true,
        capabilities: ["shell"],
      },
    ]);
  });
});
