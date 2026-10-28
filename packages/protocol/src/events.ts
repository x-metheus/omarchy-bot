import { z } from "zod";

export const EventEnvelope = z.object({
  schemaVersion: z.number().int(),
  eventId: z.string(),
  cursor: z.number().int().nonnegative(),
  occurredAt: z.string(),
  aggregateType: z.enum(["agent", "bot", "thread", "turn", "computer"]),
  aggregateId: z.string(),
  type: z.string(),
  payload: z.unknown(),
});
export type EventEnvelope<T = unknown> = z.infer<typeof EventEnvelope> & { payload?: T };

/** WebSocket /api/events control protocol. Clients never guess missed state. */
export type ClientToServer =
  | { type: "hello"; lastCursor?: number }
  | { type: "ack"; cursor: number };

export type ServerToClient =
  | { type: "hello"; cursor: number }
  | { type: "snapshot_required" }
  | { type: "event"; envelope: EventEnvelope }
  | { type: "pong" };
