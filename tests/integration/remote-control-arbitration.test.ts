import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { api, authedFetch, makeBot, pairForToken, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";
import { ProjectionClient, type ProjectionOwner } from "./helpers/projection-client.ts";

function expand(client: ProjectionClient): void {
  client.controlSocket.send(JSON.stringify({
    version: 3,
    sessionId: client.session.sessionId,
    surfaceId: client.owner.surfaceId,
    runtimeGeneration: client.session.runtimeGeneration,
    type: "view",
    mode: "expanded",
  }));
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  return promise;
}

describe("Paired Device Web Control arbitration", () => {
  let h: Harness;
  let laptop: Harness;
  let phone: Harness;
  let adapter: FakeBotScreenRuntimeAdapter;
  let owner: ProjectionOwner;
  const clients: ProjectionClient[] = [];

  beforeEach(async () => {
    adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    laptop = { ...h, token: await pairForToken(h.baseUrl, h.svc.cfg.stateDir, "laptop") };
    phone = { ...h, token: await pairForToken(h.baseUrl, h.svc.cfg.stateDir, "phone") };
    const botId = await makeBot(laptop, "Shared remote screen");
    const bot = await api<{ surfaceId: ProjectionOwner["surfaceId"] }>(laptop, "GET", `/api/bots/${botId}`);
    owner = { botId, surfaceId: bot.surfaceId };
  });

  afterEach(async () => {
    try {
      await Promise.all(clients.splice(0).map((client) => client.close()));
    } finally {
      await h.stop();
    }
  });

  test("hands the input lease from laptop to phone without interleaving stale laptop input", async () => {
    expect(laptop.token).not.toBe("");
    expect(phone.token).not.toBe("");
    expect(laptop.token).not.toBe(phone.token);
    const roster = await api<{ devices: Array<{ id: string; name: string }> }>(laptop, "GET", "/api/devices/paired");
    const devices = roster.devices.filter((device) => device.name === "laptop" || device.name === "phone");
    expect(devices.map((device) => device.name).sort()).toEqual(["laptop", "phone"]);
    expect(new Set(devices.map((device) => device.id)).size).toBe(2);

    const first = await ProjectionClient.connect(h.baseUrl, owner, "laptop", laptop.token);
    clients.push(first);
    const second = await ProjectionClient.connect(h.baseUrl, owner, "phone", phone.token);
    clients.push(second);
    expand(first);
    const firstAuthority = await first.waitForAuthority(true);
    first.sendInput("pointer-button", { x: 40, y: 50, button: "left", state: "pressed" });
    await adapter.waitForInputEvents(1);
    expect(adapter.inputEvents[0]?.event).toMatchObject({ type: "button", x: 40, y: 50, state: "pressed" });

    expand(second);
    const secondAuthority = await second.waitForAuthority(true);
    expect(secondAuthority.controllerEpoch).toBeGreaterThan(firstAuthority.controllerEpoch);
    expect(await first.waitForAuthority(false)).toMatchObject({ active: false });
    await adapter.waitForReleases(1);
    expect(adapter.releaseCount).toBe(1);
    expect(adapter.inputEvents).toHaveLength(2);
    expect(adapter.inputEvents[1]?.event).toMatchObject({
      type: "button",
      controllerEpoch: firstAuthority.controllerEpoch,
      button: "left",
      state: "released",
    });

    const firstClosed = waitForClose(first.controlSocket);
    first.controlSocket.send(JSON.stringify({
      version: 3,
      sessionId: first.session.sessionId,
      surfaceId: owner.surfaceId,
      runtimeGeneration: first.session.runtimeGeneration,
      geometryGeneration: first.session.geometryGeneration,
      controllerEpoch: firstAuthority.controllerEpoch,
      sequence: 2,
      type: "pointer-motion",
      x: 400,
      y: 500,
    }));
    await firstClosed;
    second.sendMotion(80, 90);
    await adapter.waitForInputEvents(3);
    expect(adapter.inputEvents).toHaveLength(3);
    expect(adapter.inputEvents[2]?.event).toMatchObject({
      type: "motion",
      controllerEpoch: secondAuthority.controllerEpoch,
      x: 80,
      y: 90,
    });
  });

  test("keeps one input holder when another paired device takes over and returns the pending tool", async () => {
    const query = new URLSearchParams({ botId: owner.botId, surfaceId: owner.surfaceId });
    const request = (device: Harness, action: string) =>
      authedFetch(device, `${h.baseUrl}/api/computer/${action}?${query}`, { method: "POST" });
    adapter.blockInputs();
    try {
      const sent = await sendToBot(laptop, owner.botId, "computer:click:paired-takeover");
      await adapter.waitForInputAttempts(1);
      const taking = request(laptop, "take-control");
      expect(await Promise.race([
        taking.then(() => "takeover-settled"),
        api(phone, "GET", `/api/computer/state?${query}`).then(() => "state-readable"),
      ])).toBe("state-readable");
      adapter.releaseInputs();
      const taken = await taking;
      expect(taken.status).toBe(200);
      expect(await taken.json()).toMatchObject({ ...owner, state: "user-control", takeover: "active" });

      const first = await ProjectionClient.connect(h.baseUrl, owner, "laptop", laptop.token);
      clients.push(first);
      const second = await ProjectionClient.connect(h.baseUrl, owner, "phone", phone.token);
      clients.push(second);
      expand(first);
      const authority = await first.waitForAuthority(true);
      const holdStart = adapter.inputEvents.length;
      first.sendMotion(40, 50);
      await adapter.waitForInputEvents(holdStart + 1);

      const duplicate = await request(phone, "take-control");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ...owner, state: "user-control", takeover: "active" });
      for (const device of [laptop, phone]) {
        expect(await api(device, "GET", `/api/computer/state?${query}`)).toMatchObject({
          ...owner, state: "user-control", takeover: "active",
        });
      }
      const secondClosed = waitForClose(second.controlSocket);
      second.controlSocket.send(JSON.stringify({
        version: 3,
        sessionId: second.session.sessionId,
        surfaceId: owner.surfaceId,
        runtimeGeneration: second.session.runtimeGeneration,
        geometryGeneration: second.session.geometryGeneration,
        controllerEpoch: authority.controllerEpoch,
        sequence: 1,
        type: "pointer-motion",
        x: 400,
        y: 500,
      }));
      await secondClosed;
      first.sendMotion(80, 90);
      await adapter.waitForInputEvents(holdStart + 2);
      expect(adapter.inputEvents.slice(holdStart).map((record) => record.event)).toEqual([
        expect.objectContaining({ type: "motion", controllerEpoch: authority.controllerEpoch, x: 40, y: 50 }),
        expect.objectContaining({ type: "motion", controllerEpoch: authority.controllerEpoch, x: 80, y: 90 }),
      ]);

      const returned = await request(phone, "return-to-bot");
      expect(returned.status).toBe(200);
      expect(await returned.json()).toMatchObject({ ...owner, takeover: "unavailable" });
      await waitThreadIdle(h, sent.threadId);
    } finally {
      adapter.releaseInputs();
    }
  });

  test("requires a pending computer tool for Takeover from either paired device", async () => {
    const query = new URLSearchParams({ botId: owner.botId, surfaceId: owner.surfaceId });
    for (const device of [laptop, phone]) {
      const response = await authedFetch(device, `${h.baseUrl}/api/computer/take-control?${query}`, { method: "POST" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Takeover requires a pending computer tool." });
    }
  });
});
