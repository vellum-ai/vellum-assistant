import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { productImprovementConsentFromServer } from "../telemetry/platform-consent.js";
import type { TraceTelemetryEvent } from "../telemetry/types.js";
import { getDb } from "./db-connection.js";
import { telemetryTraceEvents } from "./schema.js";

/**
 * Whether per-turn execution traces may be buffered. Trace collection is DARK
 * by default and only turns on when the user has affirmatively consented to
 * product-improvement data sharing AND has not opted out of analytics.
 *
 * Two independent gates, both required:
 *
 *  1. `collectUsageData` (local config, defaults on) — the existing analytics
 *     opt-out every other telemetry buffer already honors.
 *  2. Product-improvement consent — affirmatively on. Resolved from EITHER:
 *       - the local `shareProductImprovement` config key (defaults OFF) — an
 *         explicit local override, e.g. when a client mirrors the consent into
 *         daemon config directly; OR
 *       - the user's `share_product_improvement` consent on the platform,
 *         fetched and TTL-cached via {@link productImprovementConsentFromServer}.
 *
 * The server read fails closed (returns `false` when unknown / unreachable /
 * stale), and the local key defaults `false`, so unknown consent ⇒ off. This
 * keeps the pipeline dark until the user opts in (the platform consent defaults
 * on once the user accepts the current version, at which point the cached
 * server read flips this on).
 */
export function traceCollectionEnabled(): boolean {
  const config = getConfig();
  if (!config.collectUsageData) return false;
  return (
    config.shareProductImprovement || productImprovementConsentFromServer()
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for one buffered turn trace. */
export interface TraceEventRecord {
  conversationId: string;
  requestId: string | null;
  /** The assembled, already-redacted per-turn trace body. */
  trace: TraceTelemetryEvent["trace"];
}

/** A persisted trace event row, as the telemetry reporter consumes it. */
export interface UnreportedTraceEvent {
  id: string;
  createdAt: number;
  conversationId: string;
  requestId: string | null;
  turnIndex: number | null;
  /** The per-turn trace body, deserialized from the stored JSON. */
  trace: TraceTelemetryEvent["trace"];
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Buffer one per-turn execution trace. No-ops when trace collection is not
 * consented (the row is simply not recorded, keeping the pipeline dark).
 *
 * `turn_index` is computed at record time via a correlated count of real user
 * turns in the conversation — the same filter the `turn` / `llm_usage` event
 * streams use, so the three indexes stay aligned. The user turn that drove
 * this trace is already persisted by the time the loop exits, so the count
 * is stable.
 *
 * Best-effort: callers buffer traces as an observation side effect, so a
 * write failure must never surface to the turn. Callers wrap this in their
 * own try/catch; this function does not throw on consent-off.
 */
export function recordTraceEvent(record: TraceEventRecord): void {
  if (!traceCollectionEnabled()) return;
  const db = getDb();
  const id = uuid();
  const createdAt = Date.now();
  db.insert(telemetryTraceEvents)
    .values({
      id,
      createdAt,
      conversationId: record.conversationId,
      requestId: record.requestId,
      // Count of real user turns in the conversation up to and including now.
      // Tool-result rows persisted with role="user" are excluded — same
      // filter as `queryUnreportedTurnEvents` / `queryUnreportedUsageEvents`.
      turnIndex: sql<number>`(
        SELECT COUNT(*) FROM messages AS m2
        WHERE m2.conversation_id = ${record.conversationId}
          AND m2.role = 'user'
          AND m2.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\'
          AND m2.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'
          AND m2.created_at <= ${createdAt}
      )`,
      trace: JSON.stringify(record.trace),
    })
    .run();
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Parse the JSON-serialized trace body. Returns an empty trace shell for a
 * malformed row rather than failing the whole flush batch — a single corrupt
 * row should not block telemetry.
 */
function parseTrace(value: string): TraceTelemetryEvent["trace"] {
  const empty: TraceTelemetryEvent["trace"] = {
    exit_reason: null,
    started_at: null,
    ended_at: null,
    llm_calls: [],
    tool_calls: [],
  };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TraceTelemetryEvent["trace"];
    }
    return empty;
  } catch {
    return empty;
  }
}

/**
 * Query trace events that haven't been reported to telemetry yet. Uses a
 * compound cursor (createdAt + id) for reliable watermarking, mirroring
 * `queryUnreportedUsageEvents` / `queryUnreportedSkillLoadedEvents`.
 */
export function queryUnreportedTraceEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): UnreportedTraceEvent[] {
  const db = getDb();
  const rows = db
    .select({
      id: telemetryTraceEvents.id,
      createdAt: telemetryTraceEvents.createdAt,
      conversationId: telemetryTraceEvents.conversationId,
      requestId: telemetryTraceEvents.requestId,
      turnIndex: telemetryTraceEvents.turnIndex,
      trace: telemetryTraceEvents.trace,
    })
    .from(telemetryTraceEvents)
    .where(
      afterId
        ? or(
            gt(telemetryTraceEvents.createdAt, afterCreatedAt),
            and(
              eq(telemetryTraceEvents.createdAt, afterCreatedAt),
              gt(telemetryTraceEvents.id, afterId),
            ),
          )
        : gt(telemetryTraceEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(telemetryTraceEvents.createdAt), asc(telemetryTraceEvents.id))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    requestId: row.requestId,
    turnIndex: row.turnIndex === null ? null : Number(row.turnIndex),
    trace: parseTrace(row.trace),
  }));
}
