import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type {
  PricingResult,
  UsageEvent,
  UsageEventInput,
} from "../usage/types.js";
import { getDb } from "./db-connection.js";
import { rawAll } from "./raw-query.js";
import { llmUsageEvents } from "./schema.js";
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
    callSite: input.callSite ?? null,
    inferenceProfile: input.inferenceProfile ?? null,
    inferenceProfileSource: input.inferenceProfileSource ?? null,
    estimatedCostUsd: pricing.estimatedCostUsd,
    pricingStatus: pricing.pricingStatus,
  };
  db.insert(llmUsageEvents)
    .values({
      id: event.id,
      createdAt: event.createdAt,
      conversationId: event.conversationId,
      runId: event.runId,
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
      estimatedCostUsd: event.estimatedCostUsd,
      pricingStatus: event.pricingStatus,
      llmCallCount: event.llmCallCount ?? 1,
      metadataJson: null,
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
  estimatedCostUsd: number | null;
  pricingStatus: string;
}): UsageEvent {
  return {
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    runId: row.runId,
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
    estimatedCostUsd: row.estimatedCostUsd,
    pricingStatus: row.pricingStatus as "priced" | "unpriced",
  };
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

export function queryUnreportedUsageEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): UsageEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(llmUsageEvents)
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
  return rows.map(rowToUsageEvent);
}

// ---------------------------------------------------------------------------
// Aggregation — time-range queries for the usage dashboard
// ---------------------------------------------------------------------------

/** Epoch-millis time range (inclusive on both ends). */
export interface UsageTimeRange {
  from: number;
  to: number;
}

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
   * which aggregates events with no conversation id). For all other group-bys
   * this is always `null`.
   */
  groupId: string | null;
  /**
   * Raw stored grouping value for dimensions whose display label may differ
   * from storage (`call_site`, `inference_profile`). Omitted for legacy
   * dimensions where `group` is already the raw value.
   */
  groupKey?: string | null;
  /** Direct input tokens only; cache traffic is reported separately below. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
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
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_estimated_cost_usd: number | null;
  event_count: number;
}

/**
 * Return aggregate totals for all usage events within the given time range.
 */
export function getUsageTotals(range: UsageTimeRange): UsageTotals {
  const rows = rawAll<TotalsRow>(
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
    WHERE created_at >= ?1 AND created_at <= ?2
    `,
    range.from,
    range.to,
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

/** Fetch raw events in a time range for in-memory bucketing. */
function fetchRawBucketRows(range: UsageTimeRange): UsageEventBucketRow[] {
  return rawAll<UsageEventBucketRow>(
    /*sql*/ `
    SELECT
      created_at,
      input_tokens,
      output_tokens,
      estimated_cost_usd,
      llm_call_count
    FROM llm_usage_events
    WHERE created_at >= ?1 AND created_at <= ?2
    ORDER BY created_at ASC
    `,
    range.from,
    range.to,
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
): UsageDayBucket[] {
  const rows = fetchRawBucketRows(range);
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
): UsageDayBucket[] {
  const rows = fetchRawBucketRows(range);
  return bucketEventsByHour(rows, range, tz, options);
}

export const USAGE_GROUP_BY_DIMENSIONS = [
  "actor",
  "provider",
  "model",
  "conversation",
  "call_site",
  "inference_profile",
] as const;

export type GroupByDimension = (typeof USAGE_GROUP_BY_DIMENSIONS)[number];

export const USAGE_SERIES_GROUP_BY_DIMENSIONS = [
  "actor",
  "provider",
  "model",
  "call_site",
  "inference_profile",
] as const satisfies readonly GroupByDimension[];

const GROUP_BY_COLUMNS: Record<
  Exclude<GroupByDimension, "conversation">,
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
    groupBy === "call_site" || groupBy === "inference_profile";
  return {
    group: displayUsageGroup(groupBy, row.group_key),
    groupId: row.group_id,
    ...(includeGroupKey ? { groupKey: row.group_key } : {}),
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCacheCreationTokens: row.total_cache_creation_tokens,
    totalCacheReadTokens: row.total_cache_read_tokens,
    totalEstimatedCostUsd: row.total_estimated_cost_usd ?? 0,
    eventCount: row.event_count,
  };
}

/**
 * Return grouped breakdowns across the given time range, ordered by total
 * estimated cost descending (most expensive group first).
 */
export function getUsageGroupBreakdown(
  range: UsageTimeRange,
  groupBy: GroupByDimension,
): UsageGroupBreakdown[] {
  // Runtime allowlist — defense-in-depth against SQL injection via type assertions.
  assertGroupByDimension(groupBy);

  // Conversation grouping requires a JOIN with conversations to resolve titles.
  if (groupBy === "conversation") {
    const rows = rawAll<GroupRow>(
      /*sql*/ `
      SELECT
        CASE WHEN e.conversation_id IS NULL THEN 'Other'
             ELSE COALESCE(c.title, 'Untitled')
        END AS group_key,
        e.conversation_id                                AS group_id,
        COALESCE(SUM(e.input_tokens), 0)                 AS total_input_tokens,
        COALESCE(SUM(e.output_tokens), 0)                AS total_output_tokens,
        COALESCE(SUM(e.cache_creation_input_tokens), 0)  AS total_cache_creation_tokens,
        COALESCE(SUM(e.cache_read_input_tokens), 0)      AS total_cache_read_tokens,
        COALESCE(SUM(e.estimated_cost_usd), 0)           AS total_estimated_cost_usd,
        COALESCE(SUM(COALESCE(e.llm_call_count, 1)), 0)  AS event_count
      FROM llm_usage_events e
      LEFT JOIN conversations c ON e.conversation_id = c.id
      WHERE e.created_at >= ?1 AND e.created_at <= ?2
      GROUP BY e.conversation_id
      ORDER BY total_estimated_cost_usd DESC
      LIMIT 50
      `,
      range.from,
      range.to,
    );
    return rows.map((row) => mapGroupRow(row, groupBy));
  }

  const column = GROUP_BY_COLUMNS[groupBy];
  const rows = rawAll<GroupRow>(
    /*sql*/ `
    SELECT
      ${column}                                      AS group_key,
      NULL                                           AS group_id,
      COALESCE(SUM(input_tokens), 0)                 AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)                AS total_output_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0)  AS total_cache_creation_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0)      AS total_cache_read_tokens,
      COALESCE(SUM(estimated_cost_usd), 0)           AS total_estimated_cost_usd,
      COALESCE(SUM(COALESCE(llm_call_count, 1)), 0)  AS event_count
    FROM llm_usage_events
    WHERE created_at >= ?1 AND created_at <= ?2
    GROUP BY ${column}
    ORDER BY total_estimated_cost_usd DESC
    `,
    range.from,
    range.to,
  );
  return rows.map((row) => mapGroupRow(row, groupBy));
}

export function getUsageGroupedSeries(
  range: UsageTimeRange,
  groupBy: GroupByDimension,
  granularity: UsageGranularity,
  tz: string = "UTC",
  options: UsageBucketOptions = {},
): UsageGroupedSeriesBucket[] {
  assertGroupByDimension(groupBy);
  if (groupBy === "conversation") {
    throw new Error("Grouped usage series does not support conversation");
  }

  const column = GROUP_BY_COLUMNS[groupBy];
  const rows = rawAll<UsageGroupedBucketRow>(
    /*sql*/ `
    SELECT
      created_at,
      input_tokens,
      output_tokens,
      estimated_cost_usd,
      llm_call_count,
      ${column} AS group_key
    FROM llm_usage_events
    WHERE created_at >= ?1 AND created_at <= ?2
    ORDER BY created_at ASC
    `,
    range.from,
    range.to,
  );

  return bucketGroupedUsageEvents(rows, range, tz, {
    ...options,
    granularity,
    groupBy,
  });
}
