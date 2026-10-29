import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../../packages/api-client/src/index.ts";
import { makeBot, messages, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { LocalSidecarFixture } from "./helpers/localSidecar.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("client-tagged This Device", () => {
  let h: Harness | undefined;
  const sidecars: LocalSidecarFixture[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.close().catch(() => undefined)));
    await h?.stop();
    h = undefined;
  });

  test("a tagged client send resolves This Device; an untagged browser send fails closed", async () => {
    h = await startDaemon();
    const sidecar = await LocalSidecarFixture.connect(h.port, h.token);
    sidecars.push(sidecar);
    await sidecar.register({ deviceId: DEVICE_A, hostname: "laptop-a" });
    const botId = await makeBot(h, "Tagged client Bot");

    const tagged = new ApiClient({ baseUrl: h.baseUrl, localSidecarDeviceId: DEVICE_A, deviceToken: h.token });
    const pending = tagged.sendBotMessage(botId, { text: "local.run:echo tagged" });
    const job = await sidecar.waitForJob();
    expect(job).toMatchObject({ action: "run", hostname: "laptop-a", command: "echo tagged" });
    await sidecar.allowOnce();
    const sent = await pending;
    await waitThreadIdle(h, sent.threadId);
    expect(sidecar.executed).toEqual(["echo tagged"]);
    expect(
      (await messages(h, sent.threadId)).some((message) => (
        message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "completed"
      )),
    ).toBeTrue();

    const browser = new ApiClient({ baseUrl: h.baseUrl, deviceToken: h.token });
    const untagged = await browser.sendBotMessage(botId, { text: "local.run:echo untagged" });
    await waitThreadIdle(h, untagged.threadId);
    expect(
      (await messages(h, untagged.threadId)).some((message) => (
        message.kind === "tool" && message.toolCall?.name === "local" && message.toolCall.status === "error"
      )),
    ).toBeTrue();
    expect(sidecar.executed).toEqual(["echo tagged"]);
  });
});
