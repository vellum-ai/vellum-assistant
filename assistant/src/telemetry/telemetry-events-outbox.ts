/**
 * Storage seam for the generic `telemetry_events` outbox on the dedicated
 * telemetry database (`assistant-telemetry.db`). Rows carry the full wire
 * `TelemetryEvent` built at record time and are deleted after a successful
 * flush. No consent logic lives here — call sites own gating.
 */
import { asc, eq, inArray } from "drizzle-orm";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { telemetryEvents } from "../persistence/schema/index.js";
import type { TelemetryEvent } from "./types.js";

/** Ids per DELETE chunk — stays under SQLite's bound-variable limit. */
const DELETE_CHUNK_SIZE = 500;

/** One pending outbox row; `payload` is the wire `TelemetryEvent` JSON. */
export interface TelemetryOutboxRow {
  id: string;
  createdAt: number;
  payload: string;
}

/** One pending telemetry event to insert; `event` is the wire payload. */
export interface TelemetryOutboxInsert {
  id: string;
  name: string;
  createdAt: number;
  conversationId?: string | null;
  event: TelemetryEvent;
}

/**
 * Insert a batch of pending telemetry events as one multi-row INSERT —
 * all-or-nothing, so a mid-batch failure never leaves a partial batch
 * committed. Returns false when the telemetry DB is unavailable (degraded
 * mode), true once every row is inserted (or the batch is empty).
 */
export function insertTelemetryOutboxEvents(
  rows: TelemetryOutboxInsert[],
): boolean {
  const db = getTelemetryDb();
  if (!db) {
    return false;
  }
  if (rows.length === 0) {
    return true;
  }
  db.insert(telemetryEvents)
    .values(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        conversationId: row.conversationId ?? null,
        payload: JSON.stringify(row.event),
      })),
    )
    .run();
  return true;
}

/**
 * Insert one pending telemetry event. Returns false when the telemetry DB is
 * unavailable (degraded mode), true once the row is inserted.
 */
export function insertTelemetryOutboxEvent(
  row: TelemetryOutboxInsert,
): boolean {
  return insertTelemetryOutboxEvents([row]);
}

/**
 * Read the oldest pending rows for one event name in `(created_at, id)`
 * order. Empty when the telemetry DB is unavailable.
 */
export function queryTelemetryOutboxBatch(
  name: string,
  limit: number,
): TelemetryOutboxRow[] {
  const db = getTelemetryDb();
  if (!db) {
    return [];
  }
  return db
    .select({
      id: telemetryEvents.id,
      createdAt: telemetryEvents.createdAt,
      payload: telemetryEvents.payload,
    })
    .from(telemetryEvents)
    .where(eq(telemetryEvents.name, name))
    .orderBy(asc(telemetryEvents.createdAt), asc(telemetryEvents.id))
    .limit(limit)
    .all();
}

/** Delete flushed rows by id, in chunks. No-op when db null or ids empty. */
export function deleteTelemetryOutboxEvents(ids: string[]): void {
  const db = getTelemetryDb();
  if (!db || ids.length === 0) {
    return;
  }
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    db.delete(telemetryEvents)
      .where(inArray(telemetryEvents.id, ids.slice(i, i + DELETE_CHUNK_SIZE)))
      .run();
  }
}

/** Drop all pending rows for one event name (telemetry opt-out). */
export function discardPendingTelemetryOutboxEvents(name: string): void {
  const db = getTelemetryDb();
  if (!db) {
    return;
  }
  db.delete(telemetryEvents).where(eq(telemetryEvents.name, name)).run();
}
