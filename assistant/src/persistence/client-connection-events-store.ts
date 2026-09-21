/**
 * Durable client connection history.
 *
 * The event hub writes one row per client subscribe/dispose. Readers
 * coalesce short reconnects into flaps so a watchdog cycle is not an
 * outage. Writes are best-effort: a missing or unready database never
 * throws back into the hub.
 */

import { and, asc, eq, lt, lte, type SQL } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { InterfaceId } from "../channels/types.js";
import { getLogger } from "../util/logger.js";
import type { DrizzleDb } from "./db-connection.js";
import * as dbConnection from "./db-connection.js";
import { clientConnectionEvents } from "./schema/index.js";

const log = getLogger("client-connection-events-store");

/** How long a reconnect gap can be and still count as a flap, not an outage. */
export const CLIENT_CONNECTION_FLAP_WINDOW_MS = 60_000;

/** Rows older than this are deleted on each successful write. */
export const CLIENT_CONNECTION_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const CLIENT_CONNECTION_EVENT_REASONS = [
  "sse_open",
  "sse_close",
  "stale_replaced",
  "shed_backpressure",
  "force_disconnect",
  "cap_evicted",
] as const;

export type ClientConnectionEventReason =
  (typeof CLIENT_CONNECTION_EVENT_REASONS)[number];

/** Session-only close when a later open arrives with no recorded close. */
export type ClientConnectionSessionCloseReason =
  | ClientConnectionEventReason
  | "implicit_replaced";

const CLOSE_REASONS = new Set<ClientConnectionEventReason>([
  "sse_close",
  "stale_replaced",
  "shed_backpressure",
  "force_disconnect",
  "cap_evicted",
]);

export interface ClientConnectionEventInput {
  clientId: string;
  interfaceId: InterfaceId | string;
  connectionId: string;
  reason: ClientConnectionEventReason;
  occurredAt?: number;
  actorPrincipalId?: string;
  clientVersion?: string;
  sseWatchdog?: boolean;
  machineName?: string;
}

export interface ClientConnectionEvent {
  id: string;
  clientId: string;
  interfaceId: string;
  connectionId: string;
  reason: ClientConnectionEventReason;
  occurredAt: number;
  actorPrincipalId: string | null;
  clientVersion: string | null;
  sseWatchdog: boolean | null;
  machineName: string | null;
}

export interface ClientConnectionSession {
  clientId: string;
  interfaceId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  flapCount: number;
  openReason: ClientConnectionEventReason;
  closeReason: ClientConnectionSessionCloseReason | null;
  clientVersion: string | null;
  sseWatchdog: boolean | null;
  machineName: string | null;
  connectionIds: string[];
}

export interface ListClientConnectionHistoryParams {
  clientId?: string;
  interfaceId?: string;
  actorPrincipalId?: string;
  since?: number;
  until?: number;
  /** Max sessions to return after coalescing. Clamped to 1-500. */
  limit?: number;
  now?: number;
}

export interface ClientConnectionHistory {
  events: ClientConnectionEvent[];
  sessions: ClientConnectionSession[];
}

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;

function resolveDb(database?: DrizzleDb): DrizzleDb | null {
  if (database) {
    return database;
  }
  // Namespace import so a test mock of db-connection that omits `isDbOpen`
  // still loads. Incomplete mocks skip the probe and try `getDb()`.
  if (
    typeof dbConnection.isDbOpen === "function" &&
    !dbConnection.isDbOpen()
  ) {
    return null;
  }
  try {
    return dbConnection.getDb();
  } catch (err) {
    log.debug({ err }, "client connection history skipped: database unready");
    return null;
  }
}

function rowToEvent(
  row: typeof clientConnectionEvents.$inferSelect,
): ClientConnectionEvent {
  return {
    id: row.id,
    clientId: row.clientId,
    interfaceId: row.interfaceId,
    connectionId: row.connectionId,
    reason: row.reason as ClientConnectionEventReason,
    occurredAt: row.occurredAt,
    actorPrincipalId: row.actorPrincipalId ?? null,
    clientVersion: row.clientVersion ?? null,
    sseWatchdog: row.sseWatchdog ?? null,
    machineName: row.machineName ?? null,
  };
}

function pruneExpired(db: DrizzleDb, now: number): void {
  const cutoff = now - CLIENT_CONNECTION_EVENT_RETENTION_MS;
  db.delete(clientConnectionEvents)
    .where(lt(clientConnectionEvents.occurredAt, cutoff))
    .run();
}

/**
 * Append one hub lifecycle event. Returns null when the main database is
 * not open or the write fails. Never throws.
 */
export function recordClientConnectionEvent(
  input: ClientConnectionEventInput,
  database?: DrizzleDb,
): ClientConnectionEvent | null {
  const db = resolveDb(database);
  if (!db) {
    return null;
  }
  const now = input.occurredAt ?? Date.now();
  const row = {
    id: uuid(),
    clientId: input.clientId,
    interfaceId: input.interfaceId,
    connectionId: input.connectionId,
    reason: input.reason,
    occurredAt: now,
    actorPrincipalId: input.actorPrincipalId ?? null,
    clientVersion: input.clientVersion ?? null,
    sseWatchdog: input.sseWatchdog ?? null,
    machineName: input.machineName ?? null,
  };
  try {
    db.insert(clientConnectionEvents).values(row).run();
    pruneExpired(db, now);
    return rowToEvent(row);
  } catch (err) {
    log.debug({ err }, "failed to record client connection event");
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) {
    return DEFAULT_SESSION_LIMIT;
  }
  return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(limit)));
}

function startSession(event: ClientConnectionEvent): ClientConnectionSession {
  return {
    clientId: event.clientId,
    interfaceId: event.interfaceId,
    startedAt: event.occurredAt,
    endedAt: event.reason === "sse_open" ? null : event.occurredAt,
    durationMs: event.reason === "sse_open" ? null : 0,
    flapCount: 0,
    openReason: event.reason,
    closeReason: event.reason === "sse_open" ? null : event.reason,
    clientVersion: event.clientVersion,
    sseWatchdog: event.sseWatchdog,
    machineName: event.machineName,
    connectionIds: [event.connectionId],
  };
}

/**
 * Coalesce raw events into sessions. A close followed by an open within
 * {@link CLIENT_CONNECTION_FLAP_WINDOW_MS} continues the same session and
 * increments `flapCount`.
 */
export function coalesceClientConnectionSessions(
  events: ClientConnectionEvent[],
  now: number = Date.now(),
): ClientConnectionSession[] {
  const byClient = new Map<string, ClientConnectionEvent[]>();
  for (const event of events) {
    const list = byClient.get(event.clientId) ?? [];
    list.push(event);
    byClient.set(event.clientId, list);
  }

  const sessions: ClientConnectionSession[] = [];
  for (const clientEvents of byClient.values()) {
    clientEvents.sort((a, b) => a.occurredAt - b.occurredAt);
    let current: ClientConnectionSession | null = null;

    const finalize = () => {
      if (!current) {
        return;
      }
      if (current.endedAt == null) {
        current.durationMs = Math.max(0, now - current.startedAt);
      } else {
        current.durationMs = Math.max(0, current.endedAt - current.startedAt);
      }
      sessions.push(current);
      current = null;
    };

    for (const event of clientEvents) {
      if (event.reason === "sse_open") {
        if (
          current &&
          current.endedAt != null &&
          event.occurredAt - current.endedAt < CLIENT_CONNECTION_FLAP_WINDOW_MS
        ) {
          current.endedAt = null;
          current.closeReason = null;
          current.flapCount += 1;
          current.connectionIds.push(event.connectionId);
          current.clientVersion = event.clientVersion ?? current.clientVersion;
          current.sseWatchdog = event.sseWatchdog ?? current.sseWatchdog;
          current.machineName = event.machineName ?? current.machineName;
          continue;
        }
        if (current && current.endedAt == null) {
          current.endedAt = event.occurredAt;
          current.closeReason = "implicit_replaced";
        }
        finalize();
        current = startSession(event);
        continue;
      }

      if (!CLOSE_REASONS.has(event.reason)) {
        continue;
      }

      if (!current) {
        current = startSession(event);
        continue;
      }

      current.endedAt = event.occurredAt;
      current.closeReason = event.reason;
      if (!current.connectionIds.includes(event.connectionId)) {
        current.connectionIds.push(event.connectionId);
      }
    }
    finalize();
  }

  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

/**
 * Read raw events and coalesced sessions. Returns empty lists when the
 * database is not open.
 */
export function listClientConnectionHistory(
  params: ListClientConnectionHistoryParams = {},
  database?: DrizzleDb,
): ClientConnectionHistory {
  const db = resolveDb(database);
  if (!db) {
    return { events: [], sessions: [] };
  }

  const now = params.now ?? Date.now();
  const limit = clampLimit(params.limit);
  const filters: SQL[] = [];
  if (params.clientId) {
    filters.push(eq(clientConnectionEvents.clientId, params.clientId));
  }
  if (params.interfaceId) {
    filters.push(eq(clientConnectionEvents.interfaceId, params.interfaceId));
  }
  if (params.actorPrincipalId) {
    filters.push(
      eq(clientConnectionEvents.actorPrincipalId, params.actorPrincipalId),
    );
  }
  if (params.until != null) {
    filters.push(lte(clientConnectionEvents.occurredAt, params.until));
  }

  try {
    const query = db
      .select()
      .from(clientConnectionEvents)
      .orderBy(asc(clientConnectionEvents.occurredAt));
    const rows =
      filters.length > 0 ? query.where(and(...filters)).all() : query.all();
    const events = rows.map(rowToEvent);
    const sessions = coalesceClientConnectionSessions(events, now)
      .filter((session) => {
        return sessionOverlapsWindow(session, params.since, params.until);
      })
      .slice(0, limit);
    return {
      events: events.filter((event) => {
        return eventInWindow(event, params.since, params.until);
      }),
      sessions,
    };
  } catch (err) {
    log.debug({ err }, "failed to list client connection history");
    return { events: [], sessions: [] };
  }
}

function sessionOverlapsWindow(
  session: ClientConnectionSession,
  since?: number,
  until?: number,
): boolean {
  if (since != null && session.endedAt != null && session.endedAt < since) {
    return false;
  }
  if (until != null && session.startedAt > until) {
    return false;
  }
  return true;
}

function eventInWindow(
  event: ClientConnectionEvent,
  since?: number,
  until?: number,
): boolean {
  if (since != null && event.occurredAt < since) {
    return false;
  }
  if (until != null && event.occurredAt > until) {
    return false;
  }
  return true;
}
