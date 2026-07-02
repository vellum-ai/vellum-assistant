import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type {
  PricingResult,
  UsageEvent,
  UsageEventInput,
} from "../usage/types.js";
import { APP_VERSION } from "../version.js";
import { getDb } from "./db-connection.js";
import { rawAll } from "./raw-query.js";
import {
  buildScheduleAttributionSubquery,
  buildScheduleRunWindowExists,
  normalizeScheduleAttributionFilter,
  type ScheduleAttributionFilter,
  type ScheduleAttributionSqlParam,
} from "./schedule-attribution-sql.js";
import { conversations, llmUsageEvents } from "./schema/index.js";
import {
  bucketEventsByDay,
  bucketEventsByHour,
  type UsageEventBucketRow,
} from "./usage-buckets.js";
import {
  bucketGroupedUsageEvents,
  displayUsageGroup,
  type UsageGroupedBucketRow,
  type UsageGroupedSeriesBucket,
} from "./usage-grouped-buckets.js";

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function recordUsageEvent(
  input: UsageEventInput,
  pricing: PricingResult,
): UsageEvent {
  const db = getDb();
  const event: UsageEvent = {
    id: uuid(),
    createdAt: Date.now(),
    ...input,
    cronRunId: input.cronRunId ?? null,
    callSite: input.callSite ?? null,
    llmCallCount: input.llmCallCount ?? 1,
    inferenceProfile: input.inferenceProfile ?? null,
    inferenceProfileSource: input.inferenceProfileSource ?? null,
    estimatedCostUsd: pricing.estimatedCostUsd,
    pricingStatus: pricing.pricingStatus,
    assistantVersion: APP_VERSION,
  };
  db.insert(llmUsageEvents)
    .values({
      id: event.id,
      createdAt: event.createdAt,
      conversationId: event.conversationId,
      runId: event.runId,
      cronRunId: event.cronRunId,
      requestId: event.requestId,
      actor: event.actor,
      callSite: event.callSite,
      inferenceProfile: event.inferenceProfile,
      inferenceProfileSource: event.inferenceProfileSource,
      provider: event.provider,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      rawUsage: event.rawUsage === null ? null : JSON.stringify(event.rawUsage),
      estimatedCostUsd: event.estimatedCostUsd,
      pricingStatus: event.pricingStatus,
      llmCallCount: event.llmCallCount,
      metadataJson: null,
      // Capture the assistant's version at RECORD time so a batch flush
      // days later doesn't mis-attribute this row to whatever version
      // the assistant happens to be running on at upload time. See
      // migration 267 + `TelemetryEventBase.assistant_version` (wire).
      assistantVersion: event.assistantVersion,
    })
    .run();
  return event;
}

// ---------------------------------------------------------------------------
// Read — single-event listing
// ---------------------------------------------------------------------------

/** Map a raw DB row to a typed UsageEvent. */
function rowToUsageEvent(row: {
  id: string;
  createdAt: number;
  conversationId: string | null;
  runId: string | null;
  cronRunId: string | null;
  requestId: string | null;
  actor: string;
  callSite: string | null;
  inferenceProfile: string | null;
  inferenceProfileSource: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  rawUsage: string | null;
  estimatedCostUsd: number | null;
  pricingStatus: string;
  llmCallCount: number | null;
  assistantVersion: string | null;
}): UsageEvent {
  return {
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    runId: row.runId,
    cronRunId: row.cronRunId,
    requestId: row.requestId,
    actor: row.actor as UsageEvent["actor"],
    callSite: row.callSite as UsageEvent["callSite"],
    inferenceProfile: row.inferenceProfile,
    inferenceProfileSource:
      row.inferenceProfileSource as UsageEvent["inferenceProfileSource"],
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    rawUsage: parseRawUsage(row.rawUsage),
    estimatedCostUsd: row.estimatedCostUsd,
    pricingStatus: row.pricingStatus as "priced" | "unpriced",
    llmCallCount: row.llmCallCount,
    assistantVersion: row.assistantVersion,
  };
}

/**
 * Parse the JSON-serialized provider usage payload stored in `raw_usage`.
 * Returns `null` for missing or malformed values; malformed JSON is logged
 * and discarded rather than failing the read, because callers (admin
 * dashboards, telemetry forwarders) treat `raw_usage` as opaque diagnostic
 * data and shouldn't be blocked by a single corrupt row.
 */
function parseRawUsage(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function listUsageEvents(options?: { limit?: number }): UsageEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(llmUsageEvents)
    .orderBy(desc(llmUsageEvents.createdAt))
    .limit(options?.limit ?? 100)
    .all();
  return rows.map(rowToUsageEvent);
}

/**
 * Telemetry-flavoured `UsageEvent`: the persisted columns plus the two
 * JOIN-computed conversation-level fields the reporter needs to emit
 * for analytics (`avg turns per conversation`, `tokens on first turn`,
 * foreground/background split on llm_usage rows themselves).
 *
 * Lives next to the query that produces it so the shape stays in lockstep
 * with the SELECT; broader `UsageEvent` consumers stay untouched.
 */
export interface UnreportedUsageEvent extends UsageEvent {
  /**
   * Type of the parent conversation (`"standard"` / `"background"` /
   * `"scheduled"`). Null when the LLM call has no `conversationId`
   * (memory consolidation, background embedding work, etc.) and so no
   * `conversations` row to join against.
   */
  conversationType: string | null;
  /**
   * 1-indexed position of the user turn this LLM call belongs to within
   * the parent conversation, counting only real user turns (tool-result
   * rows persisted with role="user" are excluded — same filter as the
   * turn-event eligibility predicate). Computed as the count of user
   * messages with `created_at <= this LLM call's created_at` in the
   * parent conversation. Null when there's no parent conversation, or
   * when the LLM call fired before any user turn (rare — covers seed
   * agent starts).
   */
  turnIndex: number | null;
}

export function queryUnreportedUsageEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): UnreportedUsageEvent[] {
  const db = getDb();
  // JOIN to `conversations` to attach `conversationType`. LEFT JOIN
  // because `llm_usage_events.conversationId` is nullable — calls that
  // aren't tied to a conversation (memory consolidation, etc.) still
  // need to flush through telemetry.
  //
  // `turnIndex` is a correlated subquery counting real user turns in
  // the same conversation up to and including this LLM call's
  // `created_at`. The filter mirrors `queryUnreportedTurnEvents` so the
  // two indexes stay aligned: an LLM call fired during processing of
  // turn N reports `turn_index = N`, matching what the turn event
  // stream emitted for the triggering user message.
  const rows = db
    .select({
      id: llmUsageEvents.id,
      createdAt: llmUsageEvents.createdAt,
      conversationId: llmUsageEvents.conversationId,
      runId: llmUsageEvents.runId,
      cronRunId: llmUsageEvents.cronRunId,
      requestId: llmUsageEvents.requestId,
      actor: llmUsageEvents.actor,
      callSite: llmUsageEvents.callSite,
      inferenceProfile: llmUsageEvents.inferenceProfile,
      inferenceProfileSource: llmUsageEvents.inferenceProfileSource,
      provider: llmUsageEvents.provider,
      model: llmUsageEvents.model,
      inputTokens: llmUsageEvents.inputTokens,
      outputTokens: llmUsageEvents.outputTokens,
      cacheCreationInputTokens: llmUsageEvents.cacheCreationInputTokens,
      cacheReadInputTokens: llmUsageEvents.cacheReadInputTokens,
      rawUsage: llmUsageEvents.rawUsage,
      estimatedCostUsd: llmUsageEvents.estimatedCostUsd,
      pricingStatus: llmUsageEvents.pricingStatus,
      assistantVersion: llmUsageEvents.assistantVersion,
      llmCallCount: llmUsageEvents.llmCallCount,
      conversationType: conversations.conversationType,
      // Null when conversationId is null (no parent conversation).
      // Otherwise the count of eligible user turns up to and including
      // this LLM call's createdAt. The COALESCE guard returns null
      // (rather than 0) for the "no user turn yet" edge case so the
      // analytics layer can distinguish "before-first-turn" LLM calls.
      turnIndex: sql<number | null>`(
        CASE WHEN ${llmUsageEvents.conversationId} IS NULL THEN NULL
        ELSE (
          SELECT COUNT(*) FROM messages AS m2
          WHERE m2.conversation_id = ${llmUsageEvents.conversationId}
            AND m2.role = 'user'
            AND m2.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\'
            AND m2.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'
            AND m2.created_at <= ${llmUsageEvents.createdAt}
        )
        END
      )`.as("turn_index"),
    })
    .from(llmUsageEvents)
    .leftJoin(
      conversations,
      eq(llmUsageEvents.conversationId, conversations.id),
    )
    .where(
      afterId
        ? or(
            gt(llmUsageEvents.createdAt, afterCreatedAt),
            and(
              eq(llmUsageEvents.createdAt, afterCreatedAt),
              gt(llmUsageEvents.id, afterId),
            ),
          )
        : gt(llmUsageEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(llmUsageEvents.createdAt), asc(llmUsageEvents.id))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    ...rowToUsageEvent(row),
    conversationType: row.conversationType,
    // SQLite returns COUNT(*) as 0 when no rows match; the CASE in the
    // subquery already collapses the no-conversation case to NULL.
    // Convert the integer column to `number | null` for the typed
    // return value.
    turnIndex: row.turnIndex === null ? null : Number(row.turnIndex),
  }));
}

// ---------------------------------------------------------------------------
// Aggregation — time-range queries for the usage dashboard
// ---------------------------------------------------------------------------

/** Epoch-millis time range (inclusive on both ends). */
export interface UsageTimeRange {
  from: number;
  to: number;
}

export type UsageAggregationFilter = ScheduleAttributionFilter;

/** Aggregate totals across a time range. */
export interface UsageTotals {
  /** Direct input tokens only; cache traffic is reported separately below. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
}

export type UsageGranularity = "daily" | "hourly";

/** A single time bucket with its aggregate totals. */
export interface UsageDayBucket {
  /**
   * Stable unique identifier for the bucket. Safe for use as a SwiftUI/React
   * list key. Distinct even for DST fall-back duplicate hours (which share the
   * same `date` string). Daily buckets use `date` directly; hourly buckets use
   * "YYYY-MM-DD HH:00|<offsetMinutes>" to disambiguate repeated local hours.
   */
  bucketId: string;
  /**
   * Local-time bucket key in the requested tz:
   * "YYYY-MM-DD" (daily) or "YYYY-MM-DD HH:00" (hourly).
   * NOT unique: on DST fall-back days, two 01:00 hourly buckets share this key.
   * Use `bucketId` as a list identifier and `date` for display/sort only.
   */
  date: string;
  /**
   * Human-readable label for the bucket, formatted in the requested tz.
   * Hourly: "3pm". Daily: "Apr 11".
   */
  displayLabel?: string;
  /** Direct input tokens only; cache traffic is tracked separately in totals. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

/** A grouped breakdown row. */
export interface UsageGroupBreakdown {
  /** Display label for the group. */
  group: string;
  /**
   * Stable identifier for the group. Populated with the conversation id when
   * `groupBy === "conversation"` (and `null` for that mode's "Other" bucket,
   * which aggregates events with no conversation id) or with the schedule id
   * when `groupBy === "schedule"` (and `null` for "Other"). For all other
   * group-bys this is always `null`.
   */
  groupId: string | null;
  /**
   * Raw stored grouping value for dimensions whose display label may differ
   * from storage (`call_site`, `inference_profile`, `schedule`). Omitted for
   * legacy dimensions where `group` is already the raw value.
   */
  groupKey?: string | null;
  /** Direct input tokens only; cache traffic is reported separately below. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  /**
   * Number of turns in the conversation — the count of eligible user messages
   * (tool-result turns excluded). Only populated when `groupBy ===
   * "conversation"` (and `null` for that mode's "Other" bucket, which has no
   * parent conversation). `null` for every other grouping, where a turn count
   * has no well-defined meaning.
   */
  turnCount: number | null;
}

// -- raw row shapes returned by SQLite aggregation queries --

interface TotalsRow {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_estimated_cost_usd: number | null;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
}

interface GroupRow {
  group_key: string | null;
  group_id: string | null;
  group_label: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_estimated_cost_usd: number | null;
  event_count: number;
  /** Only selected by the conversation grouping query; absent otherwise. */
  turn_count?: number | null;
}

type UsageQueryParam = ScheduleAttributionSqlParam;

function normalizeUsageAggregationFilter(
  filter?: UsageAggregationFilter,
): UsageAggregationFilter {
  return normalizeScheduleAttributionFilter(filter);
}

function buildUsageAggregationWhere(
  range: UsageTimeRange,
  filter?: UsageAggregationFilter,
  eventAlias?: string,
  now: number = Date.now(),
): { sql: string; params: UsageQueryParam[] } {
  const normalized = normalizeUsageAggregationFilter(filter);
  const eventTable = eventAlias ?? "llm_usage_events";
  const createdAt = `${eventTable}.created_at`;
  const clauses = [`${createdAt} >= ? AND ${createdAt} <= ?`];
  const params: UsageQueryParam[] = [range.from, range.to];

  if (normalized.scheduleId) {
    const exists = buildScheduleRunWindowExists({
      eventAlias: eventTable,
      filter: normalized,
      now,
    });
    clauses.push(exists.sql);
    params.push(...exists.params);
  }

  return { sql: clauses.join(" AND "), params };
}

/**
 * Return aggregate usage for a single conversation (e.g. a subagent).
 */
export function getConversationUsageTotals(conversationId: string): {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
} {
  const rows = rawAll<{
    total_input: number;
    total_output: number;
    total_cost: number | null;
  }>(
    "usage:getConversationTotals",
    /*sql*/ `
    SELECT
      COALESCE(SUM(input_tokens + COALESCE(cache_creation_input_tokens, 0) + COALESCE(cache_read_input_tokens, 0)), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
    FROM llm_usage_events
    WHERE conversation_id = ?1
    `,
    conversationId,
  );
  const row = rows[0];
  return {
    inputTokens: row.total_input,
    outputTokens: row.total_output,
    estimatedCost: row.total_cost ?? 0,
  };
}

export function getUsageCostForConversationWindow({
  conversationId,
  from,
  to,
}: {
  conversationId: string;
  from: number;
  to: number;
}): number {
  const rows = rawAll<{ total_cost: number | null }>(
    "usage:costForConversationWindow",
    /*sql*/ `
    SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
    FROM llm_usage_events
    WHERE conversation_id = ?1
      AND created_at >= ?2
      AND created_at <= ?3
    `,
    conversationId,
    from,
    to,
  );
  return rows[0]?.total_cost ?? 0;
}

/**
 * Cost a single schedule run, attributing usage by EITHER its exact
 * `cron_run_id` stamp OR the legacy conversation + time-window fallback (for
 * un-stamped rows). Script-mode runs carry a sentinel `conversationId` that
 * matches no real rows, so they are costed purely by `cronRunId`; the window
 * branch is included only when a real `conversationId` is supplied.
 */
export function getUsageCostForRun({
  cronRunId,
  conversationId,
  from,
  to,
}: {
  cronRunId: string;
  conversationId?: string;
  from: number;
  to: number;
}): number {
  let predicate = "cron_run_id = ?1";
  const params: UsageQueryParam[] = [cronRunId];
  if (conversationId) {
    // Fallback for unstamped legacy rows only; the stamp takes precedence.
    predicate +=
      " OR (cron_run_id IS NULL AND conversation_id = ?2 AND created_at >= ?3 AND created_at <= ?4)";
    params.push(conversationId, from, to);
  }
  const rows = rawAll<{ total_cost: number | null }>(
    "usage:costForRun",
    /*sql*/ `
    SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
    FROM llm_usage_events
    WHERE ${predicate}
    `,
    ...params,
  );
  return rows[0]?.total_cost ?? 0;
}

/**
 * Return the distinct conversation ids touched by a single cron firing,
 * identified by its `cron_run_id` stamp on the usage ledger. Rows with a null
 * `conversation_id` are excluded, and the result is deduped. Returns an empty
 * array for an unknown or un-stamped run.
 */
export function listRunConversationIds(cronRunId: string): string[] {
  const rows = rawAll<{ conversation_id: string }>(
    "usage:listRunConversationIds",
    /*sql*/ `
    SELECT DISTINCT conversation_id
    FROM llm_usage_events
    WHERE cron_run_id = ?1
      AND conversation_id IS NOT NULL
    `,
    cronRunId,
  );
  return rows.map((row) => row.conversation_id);
}

/**
 * Return aggregate totals for all usage events within the given time range.
 */
export function getUsageTotals(
  range: UsageTimeRange,
  filter?: UsageAggregationFilter,
): UsageTotals {
  const where = buildUsageAggregationWhere(range, filter);
  const rows = rawAll<TotalsRow>(
    "usage:getTotals",
    /*sql*/ `
    SELECT
      COALESCE(SUM(input_tokens), 0)                              AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)                             AS total_output_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0)               AS total_cache_creation_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0)                   AS total_cache_read_tokens,
      COALESCE(SUM(estimated_cost_usd), 0)                        AS total_estimated_cost_usd,
      COALESCE(SUM(COALESCE(llm_call_count, 1)), 0)               AS event_count,
      COUNT(CASE WHEN pricing_status = 'priced' THEN 1 END)       AS priced_event_count,
      COUNT(CASE WHEN pricing_status = 'unpriced' THEN 1 END)     AS unpriced_event_count
    FROM llm_usage_events
    WHERE ${where.sql}
    `,
    ...where.params,
  );
  const row = rows[0];
  return {
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCacheCreationTokens: row.total_cache_creation_tokens,
    totalCacheReadTokens: row.total_cache_read_tokens,
    totalEstimatedCostUsd: row.total_estimated_cost_usd ?? 0,
    eventCount: row.event_count,
    pricedEventCount: row.priced_event_count,
    unpricedEventCount: row.unpriced_event_count,
  };
}

/**
 * Width of the SQL pre-aggregation bucket used by the time-series read paths,
 * in milliseconds. The series/daily endpoints bucket events into local-day or
 * local-hour buckets in JavaScript (SQLite's `strftime` is UTC-only and can't
 * honor an IANA timezone). To avoid materializing one JS object per usage event
 * — which on a 90-day window can mean hundreds of thousands of rows on the
 * daemon's main thread — we first roll events up in SQL into fixed UTC buckets,
 * then feed those far-fewer rows into the same JS bucketing logic.
 *
 * 15 minutes is the finest quantum every real-world IANA UTC offset divides
 * into (whole-hour offsets, plus the :30 and :45 zones like Asia/Kolkata and
 * Asia/Kathmandu). Because every local-day and local-hour boundary therefore
 * lands on a 15-minute UTC boundary, no pre-aggregation bucket can straddle a
 * local bucket boundary — so rolling up to 15-minute UTC buckets and then
 * re-bucketing in local time is exactly equal to bucketing each raw event.
 * DST fall-back hours stay distinct because their instants fall in different
 * 15-minute UTC buckets (and the JS layer disambiguates them by UTC offset).
 */
const USAGE_PREAGG_BUCKET_MS = 15 * 60 * 1000;

/**
 * Fetch usage rows for a time range, pre-aggregated into {@link
 * USAGE_PREAGG_BUCKET_MS} UTC buckets, for in-memory local-time bucketing. Each
 * returned row's `created_at` is its UTC bucket start, which the JS bucketing
 * maps to the same local bucket every raw event in that window would map to.
 */
function fetchRawBucketRows(
  range: UsageTimeRange,
  filter?: UsageAggregationFilter,
): UsageEventBucketRow[] {
  const where = buildUsageAggregationWhere(range, filter);
  return rawAll<UsageEventBucketRow>(
    "usage:fetchRawBucketRows",
    /*sql*/ `
    SELECT
      (created_at / ${USAGE_PREAGG_BUCKET_MS}) * ${USAGE_PREAGG_BUCKET_MS} AS created_at,
      COALESCE(SUM(input_tokens), 0)                AS input_tokens,
      COALESCE(SUM(output_tokens), 0)               AS output_tokens,
      SUM(estimated_cost_usd)                       AS estimated_cost_usd,
      SUM(COALESCE(llm_call_count, 1))              AS llm_call_count
    FROM llm_usage_events
    WHERE ${where.sql}
    GROUP BY (created_at / ${USAGE_PREAGG_BUCKET_MS})
    ORDER BY created_at ASC
    `,
    ...where.params,
  );
}

/** Options for bucket aggregation. */
export interface UsageBucketOptions {
  /**
   * When true, emit a zero-value bucket for every day (or hour) in the range
   * even if no events fall inside it. Defaults to false so the CLI and other
   * callers only see active periods; the chart route opts in.
   */
  fillEmpty?: boolean;
}

/**
 * Return per-day aggregates within the given time range, keyed by local date
 * in the requested timezone (default UTC).
 *
 * Each bucket key is a "YYYY-MM-DD" string anchored on local midnight in `tz`.
 * When `options.fillEmpty` is true, empty days within the range are filled
 * with zero-value buckets. DST-short and DST-long local days are handled
 * correctly.
 */
export function getUsageDayBuckets(
  range: UsageTimeRange,
  tz: string = "UTC",
  options: UsageBucketOptions = {},
  filter?: UsageAggregationFilter,
): UsageDayBucket[] {
  const rows = fetchRawBucketRows(range, filter);
  return bucketEventsByDay(rows, range, tz, options);
}

/**
 * Return per-hour aggregates within the given time range, keyed by local hour
 * in the requested timezone (default UTC).
 *
 * Each bucket key is a "YYYY-MM-DD HH:00" string anchored on local hour starts.
 * When `options.fillEmpty` is true, empty hours are filled with zero-value
 * buckets. DST fall-back produces two distinct buckets for the duplicated hour;
 * DST spring-forward produces 23 buckets for the affected day.
 */
export function getUsageHourBuckets(
  range: UsageTimeRange,
  tz: string = "UTC",
  options: UsageBucketOptions = {},
  filter?: UsageAggregationFilter,
): UsageDayBucket[] {
  const rows = fetchRawBucketRows(range, filter);
  return bucketEventsByHour(rows, range, tz, options);
}

export const USAGE_GROUP_BY_DIMENSIONS = [
  "actor",
  "provider",
  "model",
  "conversation",
  "call_site",
  "inference_profile",
  "schedule",
] as const;

export type GroupByDimension = (typeof USAGE_GROUP_BY_DIMENSIONS)[number];

export const USAGE_SERIES_GROUP_BY_DIMENSIONS = [
  "actor",
  "provider",
  "model",
  "call_site",
  "inference_profile",
  "schedule",
] as const satisfies readonly GroupByDimension[];

const GROUP_BY_COLUMNS: Record<
  Exclude<GroupByDimension, "conversation" | "schedule">,
  string
> = {
  actor: "actor",
  provider: "provider",
  model: "model",
  call_site: "call_site",
  inference_profile: "inference_profile",
};

const ALLOWED_DIMENSIONS = new Set<string>(USAGE_GROUP_BY_DIMENSIONS);

function assertGroupByDimension(
  groupBy: string,
): asserts groupBy is GroupByDimension {
  if (!ALLOWED_DIMENSIONS.has(groupBy)) {
    throw new Error(`Invalid groupBy dimension: ${groupBy}`);
  }
}

function mapGroupRow(
  row: GroupRow,
  groupBy: GroupByDimension,
): UsageGroupBreakdown {
  const includeGroupKey =
    groupBy === "call_site" ||
    groupBy === "inference_profile" ||
    groupBy === "schedule";
  return {
    group: row.group_label ?? displayUsageGroup(groupBy, row.group_key),
    groupId: row.group_id,
    ...(includeGroupKey ? { groupKey: row.group_key } : {}),
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCacheCreationTokens: row.total_cache_creation_tokens,
    totalCacheReadTokens: row.total_cache_read_tokens,
    totalEstimatedCostUsd: row.total_estimated_cost_usd ?? 0,
    eventCount: row.event_count,
    // Turns are only meaningful per conversation; other dimensions select no
    // turn_count column, so this collapses to null.
    turnCount: groupBy === "conversation" ? (row.turn_count ?? null) : null,
  };
}

/**
 * Return grouped breakdowns across the given time range, ordered by total
 * estimated cost descending (most expensive group first).
 */
export function getUsageGroupBreakdown(
  range: UsageTimeRange,
  groupBy: GroupByDimension,
  filter?: UsageAggregationFilter,
): UsageGroupBreakdown[] {
  // Runtime allowlist — defense-in-depth against SQL injection via type assertions.
  assertGroupByDimension(groupBy);

  const normalizedFilter = normalizeUsageAggregationFilter(filter);

  // Conversation grouping requires a JOIN with conversations to resolve titles.
  if (groupBy === "conversation") {
    const where = buildUsageAggregationWhere(range, normalizedFilter, "e");
    const rows = rawAll<GroupRow>(
      "usage:groupBreakdown:conversation",
      /*sql*/ `
      SELECT
        CASE WHEN e.conversation_id IS NULL THEN 'Other'
             ELSE COALESCE(c.title, 'Untitled')
        END AS group_key,
        e.conversation_id                                AS group_id,
        NULL                                             AS group_label,
        COALESCE(SUM(e.input_tokens), 0)                 AS total_input_tokens,
        COALESCE(SUM(e.output_tokens), 0)                AS total_output_tokens,
        COALESCE(SUM(e.cache_creation_input_tokens), 0)  AS total_cache_creation_tokens,
        COALESCE(SUM(e.cache_read_input_tokens), 0)      AS total_cache_read_tokens,
        COALESCE(SUM(e.estimated_cost_usd), 0)           AS total_estimated_cost_usd,
        COALESCE(SUM(COALESCE(e.llm_call_count, 1)), 0)  AS event_count,
        -- Number of turns in the conversation: the count of eligible user
        -- messages (tool-result turns excluded, mirroring the turnIndex
        -- definition). Evaluated once per conversation group via the
        -- idx_messages_conversation_id index rather than once per usage event,
        -- so it stays cheap as call volume grows. NULL for the "Other" (no
        -- conversation) bucket. Note: derived from surviving messages, so a
        -- turn removed via Undo (deleteLastExchange) stops being counted even
        -- though its billed usage still shows up in Cost/Tokens.
        CASE WHEN e.conversation_id IS NULL THEN NULL
             ELSE (
               SELECT COUNT(*) FROM messages AS m2
               WHERE m2.conversation_id = e.conversation_id
                 AND m2.role = 'user'
                 AND m2.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\'
                 AND m2.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'
             )
        END                                              AS turn_count
      FROM llm_usage_events e
      LEFT JOIN conversations c ON e.conversation_id = c.id
      WHERE ${where.sql}
      GROUP BY e.conversation_id
      ORDER BY total_estimated_cost_usd DESC
      LIMIT 50
      `,
      ...where.params,
    );
    return rows.map((row) => mapGroupRow(row, groupBy));
  }

  if (groupBy === "schedule") {
    const now = Date.now();
    const where = buildUsageAggregationWhere(range, normalizedFilter, "e", now);
    const groupKeySubquery = buildScheduleAttributionSubquery({
      eventAlias: "e",
      filter: normalizedFilter,
      now,
      selectExpression: "schedule_attr_runs.job_id",
    });
    const rows = rawAll<GroupRow>(
      "usage:groupBreakdown:schedule",
      /*sql*/ `
      WITH schedule_usage AS (
        SELECT
          e.input_tokens,
          e.output_tokens,
          e.cache_creation_input_tokens,
          e.cache_read_input_tokens,
          e.estimated_cost_usd,
          e.llm_call_count,
          ${groupKeySubquery.sql} AS group_key
        FROM llm_usage_events e
        WHERE ${where.sql}
      )
      SELECT
        schedule_usage.group_key                                      AS group_key,
        schedule_usage.group_key                                      AS group_id,
        MAX(schedule_group_jobs.name)                                 AS group_label,
        COALESCE(SUM(schedule_usage.input_tokens), 0)                 AS total_input_tokens,
        COALESCE(SUM(schedule_usage.output_tokens), 0)                AS total_output_tokens,
        COALESCE(SUM(schedule_usage.cache_creation_input_tokens), 0)  AS total_cache_creation_tokens,
        COALESCE(SUM(schedule_usage.cache_read_input_tokens), 0)      AS total_cache_read_tokens,
        COALESCE(SUM(schedule_usage.estimated_cost_usd), 0)           AS total_estimated_cost_usd,
        COALESCE(SUM(COALESCE(schedule_usage.llm_call_count, 1)), 0)  AS event_count
      FROM schedule_usage
      LEFT JOIN cron_jobs schedule_group_jobs
        ON schedule_group_jobs.id = schedule_usage.group_key
      GROUP BY schedule_usage.group_key
      ORDER BY total_estimated_cost_usd DESC
      `,
      ...groupKeySubquery.params,
      ...where.params,
    );
    return rows.map((row) => mapGroupRow(row, groupBy));
  }

  const column = GROUP_BY_COLUMNS[groupBy];
  const where = buildUsageAggregationWhere(range, normalizedFilter, "e");
  const rows = rawAll<GroupRow>(
    "usage:groupBreakdown:column",
    /*sql*/ `
    SELECT
      e.${column}                                      AS group_key,
      NULL                                             AS group_id,
      NULL                                             AS group_label,
      COALESCE(SUM(e.input_tokens), 0)                 AS total_input_tokens,
      COALESCE(SUM(e.output_tokens), 0)                AS total_output_tokens,
      COALESCE(SUM(e.cache_creation_input_tokens), 0)  AS total_cache_creation_tokens,
      COALESCE(SUM(e.cache_read_input_tokens), 0)      AS total_cache_read_tokens,
      COALESCE(SUM(e.estimated_cost_usd), 0)           AS total_estimated_cost_usd,
      COALESCE(SUM(COALESCE(e.llm_call_count, 1)), 0)  AS event_count
    FROM llm_usage_events e
    WHERE ${where.sql}
    GROUP BY e.${column}
    ORDER BY total_estimated_cost_usd DESC
    `,
    ...where.params,
  );
  return rows.map((row) => mapGroupRow(row, groupBy));
}

export function getUsageGroupedSeries(
  range: UsageTimeRange,
  groupBy: GroupByDimension,
  granularity: UsageGranularity,
  tz: string = "UTC",
  options: UsageBucketOptions = {},
  filter?: UsageAggregationFilter,
): UsageGroupedSeriesBucket[] {
  assertGroupByDimension(groupBy);
  if (groupBy === "conversation") {
    throw new Error("Grouped usage series does not support conversation");
  }

  const normalizedFilter = normalizeUsageAggregationFilter(filter);
  let rows: UsageGroupedBucketRow[];

  if (groupBy === "schedule") {
    const now = Date.now();
    const where = buildUsageAggregationWhere(range, normalizedFilter, "e", now);
    const groupKeySubquery = buildScheduleAttributionSubquery({
      eventAlias: "e",
      filter: normalizedFilter,
      now,
      selectExpression: "schedule_attr_runs.job_id",
    });
    rows = rawAll<UsageGroupedBucketRow>(
      "usage:groupedSeries:schedule",
      /*sql*/ `
      WITH schedule_usage AS (
        SELECT
          e.created_at,
          e.input_tokens,
          e.output_tokens,
          e.estimated_cost_usd,
          e.llm_call_count,
          ${groupKeySubquery.sql} AS group_key
        FROM llm_usage_events e
        WHERE ${where.sql}
      )
      SELECT
        (schedule_usage.created_at / ${USAGE_PREAGG_BUCKET_MS}) * ${USAGE_PREAGG_BUCKET_MS} AS created_at,
        COALESCE(SUM(schedule_usage.input_tokens), 0)            AS input_tokens,
        COALESCE(SUM(schedule_usage.output_tokens), 0)           AS output_tokens,
        SUM(schedule_usage.estimated_cost_usd)                   AS estimated_cost_usd,
        SUM(COALESCE(schedule_usage.llm_call_count, 1))          AS llm_call_count,
        schedule_usage.group_key                                 AS group_key,
        MAX(schedule_group_jobs.name)                            AS group_label
      FROM schedule_usage
      LEFT JOIN cron_jobs schedule_group_jobs
        ON schedule_group_jobs.id = schedule_usage.group_key
      GROUP BY (schedule_usage.created_at / ${USAGE_PREAGG_BUCKET_MS}), schedule_usage.group_key
      ORDER BY created_at ASC
      `,
      ...groupKeySubquery.params,
      ...where.params,
    );
  } else {
    const column = GROUP_BY_COLUMNS[groupBy];
    const where = buildUsageAggregationWhere(range, normalizedFilter, "e");
    rows = rawAll<UsageGroupedBucketRow>(
      "usage:groupedSeries:column",
      /*sql*/ `
      SELECT
        (e.created_at / ${USAGE_PREAGG_BUCKET_MS}) * ${USAGE_PREAGG_BUCKET_MS} AS created_at,
        COALESCE(SUM(e.input_tokens), 0)             AS input_tokens,
        COALESCE(SUM(e.output_tokens), 0)            AS output_tokens,
        SUM(e.estimated_cost_usd)                    AS estimated_cost_usd,
        SUM(COALESCE(e.llm_call_count, 1))           AS llm_call_count,
        e.${column} AS group_key
      FROM llm_usage_events e
      WHERE ${where.sql}
      GROUP BY (e.created_at / ${USAGE_PREAGG_BUCKET_MS}), e.${column}
      ORDER BY created_at ASC
      `,
      ...where.params,
    );
  }

  return bucketGroupedUsageEvents(rows, range, tz, {
    ...options,
    granularity,
    groupBy,
  });
}
