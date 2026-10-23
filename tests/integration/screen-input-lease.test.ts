import { describe, expect, test } from "bun:test";
import type { SurfaceId } from "../../packages/domain/src/index.ts";
import {
  ScreenInputLease,
  type ScreenInputDelivery,
  type ScreenInputTarget,
} from "../../apps/daemon/src/modules/computer/screenInputLease.ts";

const SURFACE_A = "surf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SurfaceId;
const SURFACE_B = "surf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SurfaceId;

const KEY_A = 30;
const BUTTON_LEFT = "left" as const;

interface Delivered {
  surfaceId: SurfaceId;
  epoch: number;
  kind: string;
}

function target(surfaceId: SurfaceId, generation = 1): ScreenInputTarget {
  return { surfaceId, runtimeGeneration: generation };
}

function delivery(): {
  adapter: ScreenInputDelivery;
  events: Delivered[];
  releases: Array<{ surfaceId: SurfaceId; epoch: number; keys: number[]; buttons: string[] }>;
  blockGrant: () => { release: () => void };
}
{
  const events: Delivered[] = [];
  const releases: Array<{ surfaceId: SurfaceId; epoch: number; keys: number[]; buttons: string[] }> = [];
  let grantGate: Promise<void> = Promise.resolve();
  let releaseGrant: (() => void) | undefined;
  const adapter: ScreenInputDelivery = {
    grant: async (surfaceId, epoch) => {
      await grantGate;
      events.push({ surfaceId, epoch, kind: "grant" });
      return epoch;
    },
    deliver: async (surfaceId, epoch, event) => {
      events.push({ surfaceId, epoch, kind: event.type });
    },
    release: async (surfaceId, epoch, held) => {
      releases.push({
        surfaceId,
        epoch,
        keys: [...held.keys],
        buttons: [...held.buttons],
      });
      events.push({ surfaceId, epoch, kind: "release" });
    },
    capture: async (surfaceId) => {
      events.push({ surfaceId, epoch: 0, kind: "capture" });
      return { surfaceId };
    },
  };
  return {
    adapter,
    events,
    releases,
    blockGrant: () => {
      const gate = Promise.withResolvers<void>();
      grantGate = gate.promise;
      releaseGrant = () => {
        grantGate = Promise.resolve();
        gate.resolve();
      };
      return {
        release: () => {
          releaseGrant?.();
          releaseGrant = undefined;
        },
      };
    },
  };
}

describe("ScreenInputLease", () => {
  test("rejects a stale or repeated controller epoch and delivers nothing", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A));
    expect(holder.epoch).toBe(1);
    await expect(lease.acquireWebControl(target(SURFACE_A), { epoch: 1 })).rejects.toThrow(/stale/i);
    await expect(lease.acquireWebControl(target(SURFACE_A), { epoch: holder.epoch })).rejects.toThrow(/stale/i);
    expect(sink.events.filter((event) => event.kind !== "grant")).toEqual([]);
    await holder.release();
  });

  test("a Bot input on Screen B waits while Web Control holds Screen A, and abort ends the wait", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A));
    const controller = new AbortController();
    let settled = false;
    const waiting = lease.performBotInput(target(SURFACE_B), {
      turnId: "turn-b",
      signal: controller.signal,
      run: async (send) => {
        await send({ type: "motion", x: 1, y: 2 });
      },
    }).then(
      () => {
        settled = true;
        return "ran" as const;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    await lease.seatQueued();
    expect(settled).toBeFalse();
    expect(sink.events.some((event) => event.surfaceId === SURFACE_B)).toBeFalse();

    controller.abort(new Error("steering"));
    await expect(waiting).rejects.toThrow(/steering/);
    expect(sink.events.filter((event) => event.surfaceId === SURFACE_B)).toEqual([]);

    const ran = lease.performBotInput(target(SURFACE_B), {
      turnId: "turn-b2",
      signal: new AbortController().signal,
      run: async (send) => {
        await send({ type: "motion", x: 3, y: 4 });
      },
    });
    await lease.seatQueued();
    expect(sink.events.some((event) => event.surfaceId === SURFACE_B && event.kind === "motion")).toBeFalse();
    await holder.release();
    await ran;
    expect(sink.events.some((event) => event.surfaceId === SURFACE_B && event.kind === "motion")).toBeTrue();
  });

  test("Takeover moves through requested, held, and settled, and revoke releases held keys and buttons", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const actionDone = Promise.withResolvers<void>();
    const tool = lease.beginAgentTool(SURFACE_A, { turnId: "turn-1", toolCallId: "call-1" });
    expect(lease.takeover(SURFACE_A)).toBe("available");
    expect(lease.agentToolPhase(SURFACE_A)).toBe("running");

    const requesting = lease.requestTakeover(SURFACE_A);
    expect(lease.agentToolPhase(SURFACE_A)).toBe("takeover-requested");
    expect(lease.takeover(SURFACE_A)).toBe("available");
    expect(lease.screenUse(SURFACE_A)).toBe("bot");
    actionDone.resolve();
    await tool.actionFinished(actionDone.promise);
    expect(await requesting).toEqual({ ok: true });
    expect(lease.takeover(SURFACE_A)).toBe("active");
    expect(lease.agentToolPhase(SURFACE_A)).toBe("held");
    expect(lease.screenUse(SURFACE_A)).toBe("human");

    expect(lease.beginCompletion(SURFACE_A, "call-1")).toBeTrue();
    expect(lease.takeover(SURFACE_A)).toBe("active");
    lease.failCompletion(SURFACE_A, "call-1", "held");
    expect(lease.agentToolPhase(SURFACE_A)).toBe("held");
    // A completion that never began cannot jump phases.
    lease.failCompletion(SURFACE_A, "call-1", "waiting");
    expect(lease.agentToolPhase(SURFACE_A)).toBe("held");
    expect(lease.beginCompletion(SURFACE_A, "other-call")).toBeFalse();
    expect(lease.agentToolPhase(SURFACE_A)).toBe("held");

    const holder = await lease.acquireWebControl(target(SURFACE_A));
    await holder.input({ type: "key", keyCode: KEY_A, state: "pressed" });
    await holder.input({ type: "button", x: 1, y: 1, button: BUTTON_LEFT, state: "pressed" });
    await lease.revoke(SURFACE_A);
    expect(sink.releases).toEqual([
      { surfaceId: SURFACE_A, epoch: holder.epoch, keys: [KEY_A], buttons: [BUTTON_LEFT] },
    ]);
    expect(lease.screenUse(SURFACE_A)).not.toBe("human");

    await lease.settleAgentTool(SURFACE_A, "call-1");
    expect(lease.agentToolPhase(SURFACE_A)).toBeUndefined();
    expect(lease.takeover(SURFACE_A)).toBe("unavailable");
    expect(lease.screenUse(SURFACE_A)).toBe("idle");
  });

  test("capture never waits on a held input lease", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const blocked = sink.blockGrant();
    const acquiring = lease.acquireWebControl(target(SURFACE_A));
    await lease.grantStarted();
    const capture = await lease.capture(SURFACE_B);
    expect(capture).toEqual({ surfaceId: SURFACE_B });
    expect(sink.events.some((event) => event.kind === "capture" && event.surfaceId === SURFACE_B)).toBeTrue();
    expect(sink.events.some((event) => event.kind === "grant")).toBeFalse();
    blocked.release();
    await (await acquiring).release();
  });

  test("the same Screen serializes Bot input while another Screen's capture stays immediate", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const gate = Promise.withResolvers<void>();
    const first = lease.performBotInput(target(SURFACE_A), {
      turnId: "turn-a",
      signal: new AbortController().signal,
      run: async () => {
        await gate.promise;
        return "first";
      },
    });
    await lease.seatHeld();
    let secondStarted = false;
    const order: string[] = [];
    const second = lease.performBotInput(target(SURFACE_A), {
      turnId: "turn-a2",
      signal: new AbortController().signal,
      run: async () => {
        secondStarted = true;
        order.push("second");
        return "second";
      },
    });
    const shot = lease.capture(SURFACE_A);
    expect(secondStarted).toBeFalse();
    expect(await shot).toEqual({ surfaceId: SURFACE_A });
    expect(secondStarted).toBeFalse();
    gate.resolve();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  test("aborting one cross-Screen waiter does not let the next one type", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A));
    const firstAbort = new AbortController();
    const first = lease.performBotInput(target(SURFACE_B), {
      turnId: "turn-b",
      signal: firstAbort.signal,
      run: async (send) => {
        await send({ type: "motion", x: 1, y: 1 });
      },
    });
    await lease.seatQueued();
    firstAbort.abort(new Error("steering"));
    await expect(first).rejects.toThrow(/steering/);
    let secondStarted = false;
    const second = lease.performBotInput(target(SURFACE_B), {
      turnId: "turn-b2",
      signal: new AbortController().signal,
      run: async (send) => {
        secondStarted = true;
        await send({ type: "motion", x: 2, y: 2 });
      },
    });
    await lease.seatQueued();
    expect(secondStarted).toBeFalse();
    expect(sink.events.some((event) => event.surfaceId === SURFACE_B && event.kind === "grant")).toBeFalse();
    await holder.release();
    await second;
    expect(secondStarted).toBeTrue();
  });

  test("a Bot action on the Screen the user holds waits instead of replacing the grant", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A, 1));
    let started = false;
    const bot = lease.performBotInput(target(SURFACE_A, 1), {
      turnId: "turn-a",
      signal: new AbortController().signal,
      run: async (send) => {
        started = true;
        await send({ type: "motion", x: 1, y: 1 });
      },
    });
    await lease.seatQueued();
    expect(started).toBeFalse();
    expect(sink.events.filter((event) => event.kind === "grant")).toEqual([
      { surfaceId: SURFACE_A, epoch: 1, kind: "grant" },
    ]);
    await holder.release();
    await bot;
    expect(started).toBeTrue();
  });

  test("a queued Bot is not overtaken by a Web Control grant that asked later", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A));
    const bot = lease.performBotInput(target(SURFACE_B), {
      turnId: "turn-b",
      signal: new AbortController().signal,
      run: async (send) => {
        await send({ type: "motion", x: 1, y: 1 });
      },
    });
    await lease.seatQueued();
    const web = lease.acquireWebControl(target(SURFACE_B));
    await holder.release();
    await bot;
    const grant = await web;
    expect(sink.events.filter((event) => event.kind === "grant")).toEqual([
      { surfaceId: SURFACE_A, epoch: 1, kind: "grant" },
      { surfaceId: SURFACE_B, epoch: 1, kind: "grant" },
      { surfaceId: SURFACE_B, epoch: 2, kind: "grant" },
    ]);
    await grant.release();
  });

  test("settling a requested Takeover leaves the waiting request empty-handed", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const actionDone = Promise.withResolvers<void>();
    const tool = lease.beginAgentTool(SURFACE_A, { turnId: "turn-1", toolCallId: "call-1" });
    const requesting = lease.requestTakeover(SURFACE_A);
    expect(lease.agentToolPhase(SURFACE_A)).toBe("takeover-requested");
    await lease.settleAgentTool(SURFACE_A, "call-1");
    actionDone.resolve();
    await tool.actionFinished(actionDone.promise);
    expect(await requesting).toEqual({ ok: false });
    expect(lease.takeover(SURFACE_A)).toBe("unavailable");
    expect(lease.canAcceptWebControl(SURFACE_A)).toBeTrue();
  });

  test("settling a Takeover drops the tool even when the held-input release fails", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease({
      ...sink.adapter,
      release: async () => {
        throw new Error("release failed");
      },
    });
    const tool = lease.beginAgentTool(SURFACE_A, { turnId: "turn-1", toolCallId: "call-1" });
    const actionDone = Promise.withResolvers<void>();
    const requesting = lease.requestTakeover(SURFACE_A);
    actionDone.resolve();
    await tool.actionFinished(actionDone.promise);
    expect(await requesting).toEqual({ ok: true });
    const holder = await lease.acquireWebControl(target(SURFACE_A));
    await holder.input({ type: "key", keyCode: KEY_A, state: "pressed" });

    await expect(lease.settleAgentTool(SURFACE_A, "call-1")).rejects.toThrow(/release failed/);
    expect(lease.agentToolPhase(SURFACE_A)).toBeUndefined();
    expect(lease.takeover(SURFACE_A)).toBe("unavailable");
    expect(lease.screenUse(SURFACE_A)).toBe("idle");
  });

  test("a grant for a different runtime generation is rejected", async () => {
    const sink = delivery();
    const lease = new ScreenInputLease(sink.adapter);
    const holder = await lease.acquireWebControl(target(SURFACE_A, 1));
    await expect(lease.performBotInput(target(SURFACE_A, 99), {
      turnId: "turn-stale",
      signal: new AbortController().signal,
      run: async () => "ran",
    })).rejects.toThrow(/generation/i);
    expect(sink.events.filter((event) => event.kind === "grant")).toHaveLength(1);
    await holder.release();
  });

  test("a grant in flight keeps the seat so the next caller does not enter grant", async () => {
    const events: Delivered[] = [];
    let entered: string[] = [];
    const grantEntered = Promise.withResolvers<void>();
    let gate = Promise.resolve();
    const lease = new ScreenInputLease({
      grant: async (surfaceId, epoch) => {
        entered.push(surfaceId);
        if (entered.length === 2) grantEntered.resolve();
        await gate;
        events.push({ surfaceId, epoch, kind: "grant" });
        return epoch;
      },
      deliver: async () => {},
      release: async (surfaceId, epoch) => {
        events.push({ surfaceId, epoch, kind: "release" });
      },
      capture: async (surfaceId) => ({ surfaceId }),
    });
    const runGate = Promise.withResolvers<void>();
    const first = lease.performBotInput(target(SURFACE_A), {
      turnId: "a",
      signal: new AbortController().signal,
      run: async () => {
        await runGate.promise;
      },
    });
    await lease.seatHeld();
    const blocking = Promise.withResolvers<void>();
    gate = blocking.promise;
    const webQueued = lease.seatQueued();
    const web = lease.acquireWebControl(target(SURFACE_B));
    await webQueued;
    runGate.resolve();
    await grantEntered.promise;
    expect(entered).toEqual([SURFACE_A, SURFACE_B]);
    let secondEntered = false;
    const second = lease.performBotInput(target(SURFACE_A), {
      turnId: "a2",
      signal: new AbortController().signal,
      run: async () => {
        secondEntered = true;
        return "second";
      },
    });
    await lease.seatQueued();
    expect(secondEntered).toBeFalse();
    expect(entered).toEqual([SURFACE_A, SURFACE_B]);
    blocking.resolve();
    await web.then((grant) => grant.release());
    await second;
    await first;
    expect(entered).toEqual([SURFACE_A, SURFACE_B, SURFACE_A]);
  });
});
