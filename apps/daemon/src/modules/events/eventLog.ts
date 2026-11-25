import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { EventEnvelope } from "@omarchy-bot/protocol";

type Listener = (e: EventEnvelope) => unknown;

/** Durable, monotonic event log. One SQLite writer; WS clients replay by cursor. */
export class EventLog {
  #listeners = new Map<Listener, number>();
  #queue: EventEnvelope[] = [];
  #transactionDepth = 0;
  #publishing = false;
  #committedCursor = 0;
  constructor(private readonly db: Database) {}

  /** Run synchronous writes together and publish only after SQLite commits the outer transaction. */
  transaction<T>(write: () => T): T {
    this.#requireManagedTransaction();
    const checkpoint = this.#queue.length;
    this.#transactionDepth++;
    try {
      return this.db.transaction(write)();
    } catch (error) {
      this.#queue.length = checkpoint;
      throw error;
    } finally {
      this.#transactionDepth--;
      if (this.#transactionDepth === 0) this.#publishCommitted();
    }
  }

  #requireManagedTransaction(): void {
    if (this.db.inTransaction && this.#transactionDepth === 0) {
      throw new Error("EventLog writes in a SQLite transaction require EventLog.transaction");
    }
  }

  #publishCommitted(): void {
    this.#committedCursor = this.#queue.at(-1)?.cursor ?? this.#committedCursor;
    if (this.#publishing || this.#queue.length === 0) return;
    this.#publishing = true;
    try {
      for (const event of this.#queue) {
        for (const [listener, afterCursor] of this.#listeners) {
          if (event.cursor <= afterCursor) continue;
          const report = (error: unknown) => console.error(`EventLog subscriber failed for cursor ${event.cursor}`, error);
          try {
            const result = listener(event);
            if (result instanceof Promise) void result.catch(report);
          } catch (error) {
            report(error);
          }
        }
      }
    } finally {
      this.#queue.length = 0;
      this.#publishing = false;
    }
  }

  append(aggregateType: EventEnvelope["aggregateType"], aggregateId: string, type: string, payload: unknown): EventEnvelope {
    this.#requireManagedTransaction();
    const env: EventEnvelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      cursor: 0,
      occurredAt: new Date().toISOString(),
      aggregateType,
      aggregateId,
      type,
      payload,
    };
    const r = this.db
      .query(
        `INSERT INTO events (event_id, schema_version, occurred_at, aggregate_type, aggregate_id, type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING cursor`,
      )
      .get(env.eventId, env.schemaVersion, env.occurredAt, aggregateType, aggregateId, type, JSON.stringify(payload ?? null)) as { cursor: number };
    env.cursor = r.cursor;
    this.#queue.push(env);
    if (this.#transactionDepth === 0) this.#publishCommitted();
    return env;
  }

  /** Replay after a cursor. `oldest` is returned when the client is behind retention. */
  replay(lastCursor: number, oldest: number): { events: EventEnvelope[]; snapshotRequired: boolean } {
    if (lastCursor < oldest - 1) return { events: [], snapshotRequired: true };
    const rows = this.db
      .query(`SELECT * FROM events WHERE cursor > ? ORDER BY cursor ASC`)
      .all(lastCursor) as any[];
    return {
      events: rows.map((r) => ({
        schemaVersion: r.schema_version,
        eventId: r.event_id,
        cursor: r.cursor,
        occurredAt: r.occurred_at,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        type: r.type,
        payload: JSON.parse(r.payload),
      })),
      snapshotRequired: false,
    };
  }

  oldestCursor(): number {
    const r = this.db.query(`SELECT MIN(cursor) AS c FROM events`).get() as { c: number | null };
    return r.c ?? 0;
  }

  subscribe(l: Listener): () => void {
    // A subscription opened by a listener can already have replayed the rest of the committed batch.
    if (!this.#listeners.has(l)) this.#listeners.set(l, this.#committedCursor);
    return () => this.#listeners.delete(l);
  }
}
