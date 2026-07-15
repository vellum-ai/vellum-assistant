/**
 * Generic `telemetry_events` outbox on the dedicated telemetry database
 * (`assistant-telemetry.db`). Rows carry the full wire `TelemetryEvent` built
 * at record time and are deleted after a successful flush.
 * `recordTelemetryOutboxEvent` is the consent-owning record layer; the
 * storage seam functions carry no consent logic — their call sites own
 * gating.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { telemetryEvents } from "../persistence/schema/index.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import { APP_VERSION } from "../version.js";
import type {
  OutboxTelemetryEventName,
  OutboxTelemetryEventOf,
  TelemetryEvent,
  TelemetryEventBase,
} from "./types.js";

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
 * Lower-level record escape hatch: for payloads that need the record-time
 * `(id, createdAt)` inside type-specific fields (onboarding's activation
 * `daemon_event_id` override and `completed_at`). Gates on usage-data
 * consent, generates the outbox row identity, builds the wire payload via
 * `buildEvent` (which owns all stamping), and inserts. Returns the generated
 * row identity, or null when usage data collection is disabled (the event is
 * dropped to honor the opt-out) or the telemetry DB is unavailable (degraded
 * mode). Prefer `recordTelemetryEvent` when the payload doesn't need them.
 */
export function recordTelemetryOutboxEvent(
  name: string,
  buildEvent: (id: string, createdAt: number) => TelemetryEvent,
  opts?: { conversationId?: string | null },
): { id: string; createdAt: number } | null {
  if (!getCachedShareAnalytics()) {
    return null;
  }
  const id = uuid();
  const createdAt = Date.now();
  const inserted = insertTelemetryOutboxEvent({
    id,
    name,
    createdAt,
    conversationId: opts?.conversationId ?? null,
    event: buildEvent(id, createdAt),
  });
  return inserted ? { id, createdAt } : null;
}

/**
 * Preferred record API for outbox events whose payload does not depend on
 * the record-time `(id, createdAt)`: stamps the `TelemetryEventBase` fields
 * (record-time `assistant_version` included) and inherits
 * `recordTelemetryOutboxEvent`'s consent gate and degraded-mode `null`.
 */
export function recordTelemetryEvent<N extends OutboxTelemetryEventName>(
  name: N,
  fields: Omit<OutboxTelemetryEventOf<N>, keyof TelemetryEventBase>,
  opts?: { conversationId?: string | null },
): { id: string; createdAt: number } | null {
  return recordTelemetryOutboxEvent(
    name,
    (id, createdAt) =>
      // Cast: TS cannot re-associate the `Omit<...>` spread with the stamped
      // base fields across a generic; `fields`' type guarantees the shape.
      // Base fields are stamped after the spread so a widened `fields` value
      // carrying base keys can never override them.
      ({
        ...fields,
        type: name,
        daemon_event_id: id,
        recorded_at: createdAt,
        assistant_version: APP_VERSION,
      }) as OutboxTelemetryEventOf<N>,
    opts,
  );
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

/**
 * Distinct event names with at least one pending row in the outbox. Used by the
 * orphan-drain source to find rows whose type is no longer in the wire contract
 * (e.g. recorded before the platform removed/renamed a type) so they can be
 * flushed instead of stranded. Empty when the telemetry DB is unavailable.
 */
export function queryDistinctOutboxEventNames(): string[] {
  const db = getTelemetryDb();
  if (!db) {
    return [];
  }
  return db
    .selectDistinct({ name: telemetryEvents.name })
    .from(telemetryEvents)
    .all()
    .map((row) => row.name);
}
