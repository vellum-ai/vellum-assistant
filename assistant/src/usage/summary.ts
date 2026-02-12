import { getDb } from '../memory/db.js';
import { llmUsageEvents } from '../memory/schema.js';
import { sql, and, gte, lte, eq } from 'drizzle-orm';

export interface UsageSummaryOptions {
  startAt: number;  // epoch ms
  endAt: number;    // epoch ms
  assistantId?: string;
  provider?: string;
  model?: string;
  actor?: string;
}

export interface UsageBreakdownEntry {
  key: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number | null;
  eventCount: number;
}

export interface UsageDailyBucket {
  date: string;  // YYYY-MM-DD
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number | null;
  eventCount: number;
}

export interface UsageSummary {
  totalPricedCostUsd: number;
  totalUnpricedInputTokens: number;
  totalUnpricedOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
  byProvider: UsageBreakdownEntry[];
  byModel: UsageBreakdownEntry[];
  byActor: UsageBreakdownEntry[];
  dailyBuckets: UsageDailyBucket[];
}

export function getUsageSummary(options: UsageSummaryOptions): UsageSummary {
  const db = getDb();

  // Build WHERE conditions
  const conditions = [
    gte(llmUsageEvents.createdAt, options.startAt),
    lte(llmUsageEvents.createdAt, options.endAt),
  ];
  if (options.assistantId) conditions.push(eq(llmUsageEvents.assistantId, options.assistantId));
  if (options.provider) conditions.push(eq(llmUsageEvents.provider, options.provider));
  if (options.model) conditions.push(eq(llmUsageEvents.model, options.model));
  if (options.actor) conditions.push(eq(llmUsageEvents.actor, options.actor));

  const whereClause = and(...conditions);

  // Total aggregation
  const totals = db.select({
    totalInputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    totalPricedCost: sql<number>`coalesce(sum(case when ${llmUsageEvents.pricingStatus} = 'priced' then ${llmUsageEvents.estimatedCostUsd} else 0 end), 0)`,
    totalUnpricedInputTokens: sql<number>`coalesce(sum(case when ${llmUsageEvents.pricingStatus} = 'unpriced' then ${llmUsageEvents.inputTokens} else 0 end), 0)`,
    totalUnpricedOutputTokens: sql<number>`coalesce(sum(case when ${llmUsageEvents.pricingStatus} = 'unpriced' then ${llmUsageEvents.outputTokens} else 0 end), 0)`,
    eventCount: sql<number>`count(*)`,
  }).from(llmUsageEvents).where(whereClause).get()!;

  // Breakdown by provider
  const byProvider = db.select({
    key: llmUsageEvents.provider,
    totalInputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    totalCost: sql<number | null>`sum(case when ${llmUsageEvents.pricingStatus} = 'priced' then ${llmUsageEvents.estimatedCostUsd} else null end)`,
    eventCount: sql<number>`count(*)`,
  }).from(llmUsageEvents).where(whereClause).groupBy(llmUsageEvents.provider).all();

  // Breakdown by model
  const byModel = db.select({
    key: llmUsageEvents.model,
    totalInputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    totalCost: sql<number | null>`sum(case when ${llmUsageEvents.pricingStatus} = 'priced' then ${llmUsageEvents.estimatedCostUsd} else null end)`,
    eventCount: sql<number>`count(*)`,
  }).from(llmUsageEvents).where(whereClause).groupBy(llmUsageEvents.model).all();

  // Breakdown by actor
  const byActor = db.select({
    key: llmUsageEvents.actor,
    totalInputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    totalCost: sql<number | null>`sum(case when ${llmUsageEvents.pricingStatus} = 'priced' then ${llmUsageEvents.estimatedCostUsd} else null end)`,
    eventCount: sql<number>`count(*)`,
  }).from(llmUsageEvents).where(whereClause).groupBy(llmUsageEvents.actor).all();

  // Daily buckets using SQLite date function
  // Convert epoch ms to seconds for SQLite date functions
  const dailyBuckets = db.select({
    date: sql<string>`date(${llmUsageEvents.createdAt} / 1000, 'unixepoch')`,
    totalInputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    totalCost: sql<number | null>`sum(case when ${llmUsageEvents.pricingStatus} = 'priced' then ${llmUsageEvents.estimatedCostUsd} else null end)`,
    eventCount: sql<number>`count(*)`,
  }).from(llmUsageEvents).where(whereClause)
    .groupBy(sql`date(${llmUsageEvents.createdAt} / 1000, 'unixepoch')`)
    .orderBy(sql`date(${llmUsageEvents.createdAt} / 1000, 'unixepoch')`)
    .all();

  return {
    totalPricedCostUsd: totals.totalPricedCost,
    totalUnpricedInputTokens: totals.totalUnpricedInputTokens,
    totalUnpricedOutputTokens: totals.totalUnpricedOutputTokens,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    eventCount: totals.eventCount,
    byProvider,
    byModel,
    byActor,
    dailyBuckets,
  };
}
