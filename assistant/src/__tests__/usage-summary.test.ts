import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'usage-summary-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { initializeDb, getDb } from '../memory/db.js';
import { recordUsageEvent } from '../memory/llm-usage-store.js';
import { getUsageSummary } from '../usage/summary.js';
import type { UsageEventInput, PricingResult } from '../usage/types.js';

// Initialize db once before all tests
initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function makeInput(overrides?: Partial<UsageEventInput>): UsageEventInput {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    actor: 'main_agent',
    assistantId: null,
    conversationId: null,
    runId: null,
    requestId: null,
    ...overrides,
  };
}

const pricedResult: PricingResult = {
  estimatedCostUsd: 0.0045,
  pricingStatus: 'priced',
};

const unpricedResult: PricingResult = {
  estimatedCostUsd: null,
  pricingStatus: 'unpriced',
};

/** Insert an event and override its createdAt timestamp. */
function insertEventAt(
  createdAt: number,
  inputOverrides?: Partial<UsageEventInput>,
  pricing: PricingResult = pricedResult,
): void {
  const event = recordUsageEvent(makeInput(inputOverrides), pricing);
  const db = getDb();
  db.run(`UPDATE llm_usage_events SET created_at = ${createdAt} WHERE id = '${event.id}'`);
}

// Time constants: use 2025-01-15 as the base date
const DAY_MS = 86_400_000;
const BASE_DATE = new Date('2025-01-15T12:00:00Z').getTime(); // noon UTC

describe('getUsageSummary', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test('empty window returns zeroes', () => {
    const summary = getUsageSummary({
      startAt: BASE_DATE,
      endAt: BASE_DATE + DAY_MS,
    });

    expect(summary.totalPricedCostUsd).toBe(0);
    expect(summary.totalUnpricedInputTokens).toBe(0);
    expect(summary.totalUnpricedOutputTokens).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.eventCount).toBe(0);
    expect(summary.byProvider).toHaveLength(0);
    expect(summary.byModel).toHaveLength(0);
    expect(summary.byActor).toHaveLength(0);
    expect(summary.dailyBuckets).toHaveLength(0);
  });

  test('single priced event returns correct totals', () => {
    insertEventAt(BASE_DATE, {
      inputTokens: 2000,
      outputTokens: 800,
    }, { estimatedCostUsd: 0.01, pricingStatus: 'priced' });

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + 1000,
    });

    expect(summary.totalPricedCostUsd).toBe(0.01);
    expect(summary.totalUnpricedInputTokens).toBe(0);
    expect(summary.totalUnpricedOutputTokens).toBe(0);
    expect(summary.totalInputTokens).toBe(2000);
    expect(summary.totalOutputTokens).toBe(800);
    expect(summary.eventCount).toBe(1);
  });

  test('mixed priced/unpriced events separates costs correctly', () => {
    // Priced event
    insertEventAt(BASE_DATE, {
      inputTokens: 1000,
      outputTokens: 500,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }, { estimatedCostUsd: 0.005, pricingStatus: 'priced' });

    // Unpriced event
    insertEventAt(BASE_DATE + 1000, {
      inputTokens: 3000,
      outputTokens: 1500,
      provider: 'ollama',
      model: 'llama3',
    }, unpricedResult);

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + DAY_MS,
    });

    expect(summary.totalPricedCostUsd).toBe(0.005);
    expect(summary.totalUnpricedInputTokens).toBe(3000);
    expect(summary.totalUnpricedOutputTokens).toBe(1500);
    expect(summary.totalInputTokens).toBe(4000);
    expect(summary.totalOutputTokens).toBe(2000);
    expect(summary.eventCount).toBe(2);
  });

  test('breakdown by provider groups events correctly', () => {
    insertEventAt(BASE_DATE, {
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
    }, { estimatedCostUsd: 0.005, pricingStatus: 'priced' });

    insertEventAt(BASE_DATE + 1000, {
      provider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 1000,
    }, { estimatedCostUsd: 0.01, pricingStatus: 'priced' });

    insertEventAt(BASE_DATE + 2000, {
      provider: 'openai',
      inputTokens: 500,
      outputTokens: 250,
    }, { estimatedCostUsd: 0.003, pricingStatus: 'priced' });

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + DAY_MS,
    });

    expect(summary.byProvider).toHaveLength(2);

    const anthropic = summary.byProvider.find(e => e.key === 'anthropic')!;
    expect(anthropic).toBeDefined();
    expect(anthropic.totalInputTokens).toBe(3000);
    expect(anthropic.totalOutputTokens).toBe(1500);
    expect(anthropic.totalCost).toBe(0.015);
    expect(anthropic.eventCount).toBe(2);

    const openai = summary.byProvider.find(e => e.key === 'openai')!;
    expect(openai).toBeDefined();
    expect(openai.totalInputTokens).toBe(500);
    expect(openai.totalOutputTokens).toBe(250);
    expect(openai.totalCost).toBe(0.003);
    expect(openai.eventCount).toBe(1);
  });

  test('breakdown by model groups events correctly', () => {
    insertEventAt(BASE_DATE, {
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      outputTokens: 500,
    }, pricedResult);

    insertEventAt(BASE_DATE + 1000, {
      model: 'gpt-4o',
      inputTokens: 2000,
      outputTokens: 1000,
    }, pricedResult);

    insertEventAt(BASE_DATE + 2000, {
      model: 'gpt-4o',
      inputTokens: 3000,
      outputTokens: 1500,
    }, pricedResult);

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + DAY_MS,
    });

    expect(summary.byModel).toHaveLength(2);

    const sonnet = summary.byModel.find(e => e.key === 'claude-sonnet-4-20250514')!;
    expect(sonnet).toBeDefined();
    expect(sonnet.totalInputTokens).toBe(1000);
    expect(sonnet.totalOutputTokens).toBe(500);
    expect(sonnet.eventCount).toBe(1);

    const gpt4o = summary.byModel.find(e => e.key === 'gpt-4o')!;
    expect(gpt4o).toBeDefined();
    expect(gpt4o.totalInputTokens).toBe(5000);
    expect(gpt4o.totalOutputTokens).toBe(2500);
    expect(gpt4o.eventCount).toBe(2);
  });

  test('breakdown by actor groups events correctly', () => {
    insertEventAt(BASE_DATE, {
      actor: 'main_agent',
      inputTokens: 1000,
      outputTokens: 500,
    }, pricedResult);

    insertEventAt(BASE_DATE + 1000, {
      actor: 'context_compactor',
      inputTokens: 2000,
      outputTokens: 1000,
    }, pricedResult);

    insertEventAt(BASE_DATE + 2000, {
      actor: 'main_agent',
      inputTokens: 3000,
      outputTokens: 1500,
    }, pricedResult);

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + DAY_MS,
    });

    expect(summary.byActor).toHaveLength(2);

    const mainAgent = summary.byActor.find(e => e.key === 'main_agent')!;
    expect(mainAgent).toBeDefined();
    expect(mainAgent.totalInputTokens).toBe(4000);
    expect(mainAgent.totalOutputTokens).toBe(2000);
    expect(mainAgent.eventCount).toBe(2);

    const compactor = summary.byActor.find(e => e.key === 'context_compactor')!;
    expect(compactor).toBeDefined();
    expect(compactor.totalInputTokens).toBe(2000);
    expect(compactor.totalOutputTokens).toBe(1000);
    expect(compactor.eventCount).toBe(1);
  });

  test('daily buckets assigns events to correct dates', () => {
    // Day 1: 2025-01-15 noon UTC
    insertEventAt(BASE_DATE, {
      inputTokens: 1000,
      outputTokens: 500,
    }, { estimatedCostUsd: 0.005, pricingStatus: 'priced' });

    // Day 2: 2025-01-16 noon UTC
    insertEventAt(BASE_DATE + DAY_MS, {
      inputTokens: 2000,
      outputTokens: 1000,
    }, { estimatedCostUsd: 0.01, pricingStatus: 'priced' });

    // Day 2: 2025-01-16 afternoon UTC (same day, second event)
    insertEventAt(BASE_DATE + DAY_MS + 3_600_000, {
      inputTokens: 500,
      outputTokens: 250,
    }, { estimatedCostUsd: 0.002, pricingStatus: 'priced' });

    // Day 3: 2025-01-17 noon UTC
    insertEventAt(BASE_DATE + 2 * DAY_MS, {
      inputTokens: 3000,
      outputTokens: 1500,
    }, { estimatedCostUsd: 0.015, pricingStatus: 'priced' });

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + 3 * DAY_MS,
    });

    expect(summary.dailyBuckets).toHaveLength(3);

    // Buckets should be in ascending date order
    expect(summary.dailyBuckets[0].date).toBe('2025-01-15');
    expect(summary.dailyBuckets[0].totalInputTokens).toBe(1000);
    expect(summary.dailyBuckets[0].totalOutputTokens).toBe(500);
    expect(summary.dailyBuckets[0].eventCount).toBe(1);

    expect(summary.dailyBuckets[1].date).toBe('2025-01-16');
    expect(summary.dailyBuckets[1].totalInputTokens).toBe(2500);
    expect(summary.dailyBuckets[1].totalOutputTokens).toBe(1250);
    expect(summary.dailyBuckets[1].eventCount).toBe(2);

    expect(summary.dailyBuckets[2].date).toBe('2025-01-17');
    expect(summary.dailyBuckets[2].totalInputTokens).toBe(3000);
    expect(summary.dailyBuckets[2].totalOutputTokens).toBe(1500);
    expect(summary.dailyBuckets[2].eventCount).toBe(1);
  });

  test('filter by assistantId works', () => {
    insertEventAt(BASE_DATE, {
      assistantId: 'assistant-1',
      inputTokens: 1000,
      outputTokens: 500,
    }, pricedResult);

    insertEventAt(BASE_DATE + 1000, {
      assistantId: 'assistant-2',
      inputTokens: 2000,
      outputTokens: 1000,
    }, pricedResult);

    insertEventAt(BASE_DATE + 2000, {
      assistantId: 'assistant-1',
      inputTokens: 3000,
      outputTokens: 1500,
    }, pricedResult);

    const summary = getUsageSummary({
      startAt: BASE_DATE - 1000,
      endAt: BASE_DATE + DAY_MS,
      assistantId: 'assistant-1',
    });

    expect(summary.eventCount).toBe(2);
    expect(summary.totalInputTokens).toBe(4000);
    expect(summary.totalOutputTokens).toBe(2000);
  });

  test('time window boundaries exclude out-of-range events', () => {
    const windowStart = BASE_DATE;
    const windowEnd = BASE_DATE + DAY_MS;

    // Before window
    insertEventAt(windowStart - 1000, {
      inputTokens: 100,
      outputTokens: 50,
    }, pricedResult);

    // Inside window (at start boundary)
    insertEventAt(windowStart, {
      inputTokens: 1000,
      outputTokens: 500,
    }, pricedResult);

    // Inside window
    insertEventAt(windowStart + DAY_MS / 2, {
      inputTokens: 2000,
      outputTokens: 1000,
    }, pricedResult);

    // Inside window (at end boundary)
    insertEventAt(windowEnd, {
      inputTokens: 3000,
      outputTokens: 1500,
    }, pricedResult);

    // After window
    insertEventAt(windowEnd + 1000, {
      inputTokens: 100,
      outputTokens: 50,
    }, pricedResult);

    const summary = getUsageSummary({
      startAt: windowStart,
      endAt: windowEnd,
    });

    // Should include events at boundaries (gte/lte) and inside, exclude outside
    expect(summary.eventCount).toBe(3);
    expect(summary.totalInputTokens).toBe(6000);
    expect(summary.totalOutputTokens).toBe(3000);
  });
});
