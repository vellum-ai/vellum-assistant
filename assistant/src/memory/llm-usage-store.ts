import { desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getDb } from './db.js';
import { llmUsageEvents } from './schema.js';
import type { UsageEventInput, UsageEvent, PricingResult } from '../usage/types.js';

export function recordUsageEvent(input: UsageEventInput, pricing: PricingResult): UsageEvent {
  const db = getDb();
  const event: UsageEvent = {
    id: uuid(),
    createdAt: Date.now(),
    ...input,
    estimatedCostUsd: pricing.estimatedCostUsd,
    pricingStatus: pricing.pricingStatus,
  };
  db.insert(llmUsageEvents).values({
    id: event.id,
    createdAt: event.createdAt,
    assistantId: 'self',
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
    metadataJson: null,
  }).run();
  return event;
}

export function listUsageEvents(options?: { limit?: number }): UsageEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(llmUsageEvents)
    .orderBy(desc(llmUsageEvents.createdAt))
    .limit(options?.limit ?? 100)
    .all();
  return rows.map(row => ({
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    runId: row.runId,
    requestId: row.requestId,
    actor: row.actor as UsageEvent['actor'],
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    pricingStatus: row.pricingStatus as 'priced' | 'unpriced',
  }));
}
