import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "../../packages/api-client/src/index.ts";
import { handleComputerRequest } from "../../apps/daemon/src/api/computerRoutes.ts";
import type { ComputerSurfaceOwner } from "../../apps/daemon/src/modules/computer/broker.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { api, authedFetch, makeBot, sendToBot, startDaemon, type Harness } from "./helpers/harness.ts";

async function computerRequest<T>(h: Harness, method: string, path: string): Promise<{ response: Response; body: T }> {
  const response = await authedFetch(h, `${h.baseUrl}${path}`, { method });
  const contentType = response.headers.get("content-type");
  return {
    response,
    body: (contentType?.startsWith("application/json") ? await response.json() : await response.arrayBuffer()) as T,
  };
}

type SurfaceOwner = ComputerSurfaceOwner;

async function ownerFor(h: Harness, botId: string): Promise<SurfaceOwner> {
  const bot = await api<{ id: string; surfaceId: string }>(h, "GET", `/api/bots/${botId}`);
  return { botId: bot.id, surfaceId: bot.surfaceId as ComputerSurfaceOwner["surfaceId"] };
}

function computerPath(path: string, owner: SurfaceOwner): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`;
}


async function waitForTurnStatus(h: Harness, turnId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const row = h.svc.db.query("SELECT status FROM turns WHERE id = ?").get(turnId) as { status: string } | null;
    if (row?.status === status) return;
    if (Date.now() >= deadline) throw new Error(`turn ${turnId} did not reach ${status}; current=${row?.status ?? "missing"}`);
    await Bun.sleep(20);
  }
}

async function waitForComputerState(
  h: Harness,
  owner: SurfaceOwner,
  expected: string,
  activate = expected === "ready",
): Promise<{
  botId: string;
  surfaceId: string;
  state: string;
  takeover: "unavailable" | "available" | "active";
  activity?: string;
  previewAt?: string;
}> {
  if (activate) {
    await authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/snapshot", owner)}`);
  }
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await computerRequest<{
      botId: string;
      surfaceId: string;
      state: string;
      takeover: "unavailable" | "available" | "active";
      activity?: string;
      previewAt?: string;
    }>(
      h,
      "GET",
      computerPath("/api/computer/state", owner),
    );
    if (result.body.state === expected) return result.body;
    if (Date.now() >= deadline) {
      throw new Error(`Computer Surface did not reach ${expected}; current=${result.body.state}`);
    }
  }
}

describe("contextual computer control", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
  });


  test("new Bots own distinct stable opaque Computer Surfaces", async () => {
    const first = await api<{ id: string; surfaceId: string }>(h, "POST", "/api/bots", {
      name: "First screen",
      instructions: "",
      agentId: "pi",
    });
    const second = await api<{ id: string; surfaceId: string }>(h, "POST", "/api/bots", {
      name: "Second screen",
      instructions: "",
      agentId: "pi",
    });

    expect(first.surfaceId).toMatch(/^surf_[0-9a-f]{32}$/);
    expect(second.surfaceId).toMatch(/^surf_[0-9a-f]{32}$/);
    expect(second.surfaceId).not.toBe(first.surfaceId);
    expect((await api<{ surfaceId: string }>(h, "GET", `/api/bots/${first.id}`)).surfaceId).toBe(first.surfaceId);
  });

  test("Computer routes reject a missing Bot and Surface association", async () => {
    const response = await authedFetch(h, `${h.baseUrl}/api/computer/state`);
    expect(response.status).toBe(400);
  });

  test("Computer routes reject mismatched Bot and Surface ownership", async () => {
    const first = await api<{ id: string; surfaceId: string }>(h, "POST", "/api/bots", {
      name: "First owner",
      instructions: "",
      agentId: "pi",
    });
    const second = await api<{ id: string; surfaceId: string }>(h, "POST", "/api/bots", {
      name: "Second owner",
      instructions: "",
      agentId: "pi",
    });

    const response = await authedFetch(
      h,
      `${h.baseUrl}/api/computer/state?botId=${first.id}&surfaceId=${second.surfaceId}`,
    );
    expect(response.status).toBe(404);
  });

  test("polling a closed Computer Surface does not provision it", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const owner = await ownerFor(h, await makeBot(h, "Lazy screen"));

    for (let poll = 0; poll < 3; poll += 1) {
      const status = await computerRequest<{ state: string; activity?: string }>(
        h,
        "GET",
        computerPath("/api/computer/state", owner),
      );
      expect(status.body).toMatchObject({ state: "starting", activity: "Screen starting." });
    }
    expect(adapter.starts).toHaveLength(0);

    const preview = await computerRequest<ArrayBuffer>(
      h,
      "GET",
      computerPath("/api/computer/snapshot", owner),
    );
    expect(preview.response.status).toBe(200);
    expect(adapter.starts).toHaveLength(1);
    expect(await waitForComputerState(h, owner, "ready")).toMatchObject({
      state: "ready",
      activity: "Screen ready.",
    });
  });

  test("the shared API client preserves capacity-full Computer state", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter, botScreenCapacity: 1 });
    const admitted = await ownerFor(h, await makeBot(h, "Admitted screen"));
    const waiting = await ownerFor(h, await makeBot(h, "Waiting screen"));

    const admittedPreview = await computerRequest<ArrayBuffer>(
      h,
      "GET",
      computerPath("/api/computer/snapshot", admitted),
    );
    expect(admittedPreview.response.status).toBe(200);

    const client = new ApiClient({ baseUrl: h.baseUrl, deviceToken: h.token });
    await expect(client.computerState(waiting)).resolves.toEqual({
      ...waiting,
      state: "unavailable",
      takeover: "unavailable",
      activity: "Bot Screen capacity is full (1/1).",
      unavailableReason: "capacity",
      capacity: { active: 1, limit: 1 },
    });
    expect(adapter.starts).toHaveLength(1);
  });

  test("missing Sway reports Screen unavailable without falling back to another desktop", async () => {
    const previousSwayBin = process.env.OMARCHY_BOT_SWAY_BIN;
    process.env.OMARCHY_BOT_SWAY_BIN = "/definitely/missing/sway";
    await h.stop();
    try {
      h = await startDaemon(undefined, { useProductionBotScreen: true });
    } finally {
      if (previousSwayBin === undefined) delete process.env.OMARCHY_BOT_SWAY_BIN;
      else process.env.OMARCHY_BOT_SWAY_BIN = previousSwayBin;
    }
    const owner = await ownerFor(h, await makeBot(h, "Unavailable screen"));

    const preview = await computerRequest<{ error: string }>(
      h,
      "GET",
      computerPath("/api/computer/snapshot", owner),
    );
    expect(preview.response.status).toBe(503);

    expect(await waitForComputerState(h, owner, "unavailable")).toEqual({
      ...owner,
      state: "unavailable",
      activity: "configured Sway executable is unavailable: /definitely/missing/sway",
      takeover: "unavailable",
    });

    const projection = await authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/projection", owner)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 3 }),
    });
    expect(projection.status).toBe(503);
  }, 20_000);

  test("opening preview captures directly from the assigned Bot Screen", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Preview screen"));

    const snapshot = await computerRequest<ArrayBuffer>(
      h,
      "GET",
      computerPath("/api/computer/snapshot", owner),
    );

    expect(snapshot.response.status).toBe(200);
    expect(snapshot.response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(snapshot.body).toString("base64")).toBe(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
    );
    expect(await waitForComputerState(h, owner, "ready")).toMatchObject({
      ...owner,
      previewAt: expect.any(String),
    });
  });
  test("Computer Preview timestamps remain scoped to their Bot Screen", async () => {
    const first = await ownerFor(h, await makeBot(h, "Observer"));
    const second = await ownerFor(h, await makeBot(h, "Other observer"));


    const snapshot = await computerRequest<ArrayBuffer>(h, "GET", computerPath("/api/computer/snapshot", first));
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.response.headers.get("content-type")).toBe("image/png");
    expect(snapshot.body.byteLength).toBeGreaterThan(0);

    h.svc.screens.open(second);
    const firstState = await waitForComputerState(h, first, "ready", false);
    const secondState = await waitForComputerState(h, second, "ready", false);
    expect(firstState).toMatchObject({ ...first, state: "ready", previewAt: expect.any(String) });
    expect(secondState).toEqual({
      ...second,
      state: "ready",
      activity: "Screen ready.",
      takeover: "unavailable",
    });
  });

  test("different Bot Screens capture concurrently while one Screen serializes its requests", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const first = await ownerFor(h, await makeBot(h, "First concurrent screen"));
    const second = await ownerFor(h, await makeBot(h, "Second concurrent screen"));
    adapter.blockFirstCapture(first.surfaceId);

    const firstRequest = authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/snapshot", first)}`);
    await adapter.waitForBlockedCapture();
    const secondRequestOnFirst = authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/snapshot", first)}`);
    const independent = authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/snapshot", second)}`);

    const independentResponse = await independent;
    expect(independentResponse.status).toBe(200);
    expect(adapter.captureStarts(second.surfaceId)).toBe(1);

    adapter.releaseBlockedCapture();
    const responses = await Promise.all([firstRequest, secondRequestOnFirst]);
    expect(responses.every((response) => response.status === 200)).toBeTrue();
    expect(adapter.maxConcurrentCaptures(first.surfaceId)).toBe(1);
  });


  test("one failed Screen runtime leaves another Screen ready and capturable", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const failed = await ownerFor(h, await makeBot(h, "Failed screen"));
    const unaffected = await ownerFor(h, await makeBot(h, "Unaffected screen"));

    await computerRequest(h, "GET", computerPath("/api/computer/state", failed));
    await computerRequest(h, "GET", computerPath("/api/computer/state", unaffected));
    await Promise.all([
      waitForComputerState(h, failed, "ready"),
      waitForComputerState(h, unaffected, "ready"),
    ]);

    adapter.exitDesktop(failed.surfaceId, "test worker failed");
    expect(await waitForComputerState(h, failed, "unavailable")).toMatchObject(failed);
    const snapshot = await computerRequest<ArrayBuffer>(
      h,
      "GET",
      computerPath("/api/computer/snapshot", unaffected),
    );
    expect(snapshot.response.status).toBe(200);
    expect(await waitForComputerState(h, unaffected, "ready")).toMatchObject(unaffected);
  });

  test("every Bot Screen lifecycle transition emits Surface-scoped state", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const owner = await ownerFor(h, await makeBot(h, "Lifecycle events"));
    const lifecycle: string[] = [];
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (
        event.aggregateType !== "computer"
        || event.aggregateId !== owner.surfaceId
        || event.type !== "computer.state.changed"
      ) return;
      const payload = event.payload;
      if (
        payload !== null
        && typeof payload === "object"
        && "lifecycle" in payload
        && typeof payload.lifecycle === "string"
      ) {
        lifecycle.push(payload.lifecycle);
      }
    });

    try {
      const preview = await computerRequest<ArrayBuffer>(
        h,
        "GET",
        computerPath("/api/computer/snapshot", owner),
      );
      expect(preview.response.status).toBe(200);
      await waitForComputerState(h, owner, "ready");
      adapter.crash(owner.surfaceId, "lifecycle event failure");
      await waitForComputerState(h, owner, "unavailable");
      await api(h, "DELETE", `/api/bots/${owner.botId}`, {});
      expect(lifecycle).toEqual(["starting", "ready", "failed", "stopped"]);
    } finally {
      unsubscribe();
    }
  });


  test("restart recovery emits scoped lifecycle state after Broker subscription", async () => {
    await h.stop();
    const adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
    const owner = await ownerFor(h, await makeBot(h, "Recovery events"));
    await waitForComputerState(h, owner, "ready");
    const previousEvents = h.svc.events.replay(0, h.svc.events.oldestCursor()).events;
    const cursor = previousEvents.at(-1)?.cursor ?? 0;
    const home = h.home;

    await h.disconnectForRestart();
    h = await startDaemon(home, { botScreenAdapter: adapter });

    const recoveredLifecycle = h.svc.events
      .replay(cursor, h.svc.events.oldestCursor())
      .events
      .filter((event) =>
        event.aggregateType === "computer"
        && event.aggregateId === owner.surfaceId
        && event.type === "computer.state.changed"
      )
      .flatMap((event) => {
        const payload = event.payload;
        if (
          payload !== null
          && typeof payload === "object"
          && "lifecycle" in payload
          && typeof payload.lifecycle === "string"
        ) return [payload.lifecycle];
        return [];
      });
    expect(recoveredLifecycle).toContain("ready");
  }, 15_000);


  test("an active turn without a pending computer tool cannot enter Takeover", async () => {
    const botId = await makeBot(h, "Driver");
    const owner = await ownerFor(h, botId);
    const turn = await sendToBot(h, botId, "hang");
    await waitForTurnStatus(h, turn.turnId, "working");

    const taken = await computerRequest<{ error: string }>(
      h,
      "POST",
      computerPath("/api/computer/take-control", owner),
    );
    expect(taken.response.status).toBe(409);
    expect(taken.body.error).toBe("Takeover requires a pending computer tool.");
    expect(h.svc.threads.turnRow(turn.turnId)?.status).toBe("working");
  });


  test("permanent deletion removes its Bot Screen identity", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Deleted screen"));
    expect((
      await computerRequest(h, "GET", computerPath("/api/computer/snapshot", owner))
    ).response.status).toBe(200);

    const deleted = await api<{ status: string }>(h, "DELETE", `/api/bots/${owner.botId}`, {});
    expect(deleted.status).toBe("deleted");
    expect(h.svc.db.query(`SELECT surface_id FROM bot_surfaces WHERE surface_id = ?`).get(owner.surfaceId)).toBeNull();
    expect((await authedFetch(h, `${h.baseUrl}${computerPath("/api/computer/state", owner)}`)).status).toBe(404);
  });

  test("non-computer requests are left to the parent router", async () => {
    expect(
      await handleComputerRequest(
        new Request(`${h.baseUrl}/api/health`),
        h.svc.computer,
        h.svc.screens,
      ),
    ).toBeUndefined();
    expect(await api<{ ok: boolean }>(h, "GET", "/api/health")).toMatchObject({ ok: true });
  });
});
