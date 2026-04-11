import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type {
  PricingResult,
  UsageEvent,
  UsageEventInput,
} from "../usage/types.js";
import { getDb } from "./db.js";
import { rawAll } from "./raw-query.js";
import { llmUsageEvents } from "./schema.js";
import {
  bucketEventsByDay,
  bucketEventsByHour,
  type UsageEventBucketRow,
} from "./usage-buckets.js";

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
   * Local-time bucket key in the requested tz:
   * "YYYY-MM-DD" (daily) or "YYYY-MM-DD HH:00" (hourly).
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

/** A grouped breakdown row (by actor, provider, or model). */
export interface UsageGroupBreakdown {
  group: string;
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
  group_key: string;
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

type GroupByDimension = "actor" | "provider" | "model" | "conversation";

/**
 * Return grouped breakdowns across the given time range, ordered by total
 * estimated cost descending (most expensive group first).
 */
export function getUsageGroupBreakdown(
  range: UsageTimeRange,
  groupBy: GroupByDimension,
): UsageGroupBreakdown[] {
  // Runtime allowlist — defense-in-depth against SQL injection via type assertions.
  const ALLOWED_DIMENSIONS = new Set<string>([
    "actor",
    "provider",
    "model",
    "conversation",
  ]);
  if (!ALLOWED_DIMENSIONS.has(groupBy)) {
    throw new Error(`Invalid groupBy dimension: ${groupBy}`);
  }

  // Conversation grouping requires a JOIN with conversations to resolve titles.
  if (groupBy === "conversation") {
    const rows = rawAll<GroupRow>(
      /*sql*/ `
      SELECT
        CASE WHEN e.conversation_id IS NULL THEN 'Other'
             ELSE COALESCE(c.title, 'Untitled')
        END AS group_key,
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
    return rows.map((r) => ({
      group: r.group_key,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCacheCreationTokens: r.total_cache_creation_tokens,
      totalCacheReadTokens: r.total_cache_read_tokens,
      totalEstimatedCostUsd: r.total_estimated_cost_usd ?? 0,
      eventCount: r.event_count,
    }));
  }

  const column = groupBy;
  const rows = rawAll<GroupRow>(
    /*sql*/ `
    SELECT
      ${column}                                      AS group_key,
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
  return rows.map((r) => ({
    group: r.group_key,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    totalCacheCreationTokens: r.total_cache_creation_tokens,
    totalCacheReadTokens: r.total_cache_read_tokens,
    totalEstimatedCostUsd: r.total_estimated_cost_usd ?? 0,
    eventCount: r.event_count,
  }));
}
