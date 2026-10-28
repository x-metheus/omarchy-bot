import type { ComputerViewDto } from "@omarchy-bot/protocol";
import type { ComputerBroker, ComputerBrokerState } from "../modules/computer/broker.ts";
import type { BotScreenLifecycle, BotScreenManager } from "../modules/computer/botScreenManager.ts";

const JSON_HEADERS = { "content-type": "application/json" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** Maps one Bot Screen lifecycle and control state to public vocabulary. */
export function computerView(state: ComputerBrokerState, lifecycle: BotScreenLifecycle): ComputerViewDto {
  const identity = {
    botId: state.botId,
    surfaceId: state.surfaceId,
    takeover: state.takeover,
    ...(state.takeoverReason === undefined ? {} : { takeoverReason: state.takeoverReason }),
  };
  const preview = state.lastImageAt === undefined ? {} : { previewAt: state.lastImageAt };
  if (lifecycle.admission?.reason === "capacity") {
    const { active, limit } = lifecycle.admission;
    return {
      ...identity,
      state: "unavailable",
      activity: `Bot Screen capacity is full (${active}/${limit}).`,
      unavailableReason: "capacity",
      capacity: { active, limit },
      ...preview,
    };
  }
  if (lifecycle.state === "starting" || lifecycle.state === "stopped") {
    return { ...identity, state: "starting", activity: "Screen starting.", ...preview };
  }
  if (lifecycle.state === "failed") {
    return {
      ...identity,
      state: "unavailable",
      activity: lifecycle.failure ?? "Screen unavailable.",
      ...preview,
    };
  }
  if (state.takeoverReason !== undefined && !state.webControlActive) {
    return { ...identity, state: "needs-you", activity: "Screen needs you.", ...preview };
  }
  if (state.screenUse === "human") {
    return { ...identity, state: "user-control", activity: "You have control.", ...preview };
  }
  if (state.screenUse === "bot") {
    return { ...identity, state: "bot-using", activity: "Bot using screen.", ...preview };
  }
  return { ...identity, state: "ready", activity: "Screen ready.", ...preview };
}

/** Every public Computer operation fails closed unless Bot and Surface ownership match. */
export async function handleComputerRequest(
  req: Request,
  computer: ComputerBroker,
  screens: BotScreenManager,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const knownPath = [
    "/api/computer/state",
    "/api/computer/take-control",
    "/api/computer/return-to-bot",
    "/api/computer/snapshot",
  ].includes(url.pathname);
  if (!knownPath) return undefined;

  const botId = url.searchParams.get("botId");
  const surfaceId = url.searchParams.get("surfaceId");
  if (botId === null || surfaceId === null) return json({ error: "botId and surfaceId are required" }, 400);
  const owner = computer.resolveOwner(botId, surfaceId);
  if (owner === undefined) return json({ error: "Computer Surface was not found for this Bot" }, 404);
  const currentView = (): ComputerViewDto => computerView(computer.state(owner), screens.open(owner));

  if (url.pathname === "/api/computer/state" && req.method === "GET") {
    const lifecycle = screens.status(owner);
    return json(computerView(computer.state(owner), lifecycle), lifecycle.admission === undefined ? 200 : 503);
  }
  if (url.pathname === "/api/computer/take-control" && req.method === "POST") {
    if (!await screens.ensureReady(owner)) return json(currentView(), 503);
    const takeover = await computer.takeOver(owner);
    if (!takeover.ok) return json({ error: "Takeover requires a pending computer tool." }, 409);
    return json(currentView());
  }
  if (url.pathname === "/api/computer/return-to-bot" && req.method === "POST") {
    if (!await screens.ensureReady(owner)) return json(currentView(), 503);
    try {
      await computer.imDone(owner);
      return json(currentView());
    } catch (error) {
      if (error instanceof Error && error.message === "Takeover is not active") {
        return json({ error: "Takeover is not active." }, 409);
      }
      const stillControlled = computer.state(owner).screenUse === "human";
      return json({
        error: stillControlled
          ? "The Bot Screen could not be observed. You still have control."
          : "The Bot Screen could not be observed and Web Control was interrupted. Reconnect to continue Takeover.",
      }, 502);
    }
  }
  if (url.pathname === "/api/computer/snapshot" && req.method === "GET") {
    const snapshot = await computer.snapshot(owner);
    if (snapshot === undefined) return json({ error: "Computer Preview is unavailable." }, 503);
    return new Response(snapshot.bytes as unknown as BodyInit, {
      headers: { "content-type": snapshot.mediaType, "cache-control": "no-store" },
    });
  }
  return undefined;
}
