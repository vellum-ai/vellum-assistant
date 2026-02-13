import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'budget-policy-test-'));

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
import { evaluateBudgets } from '../usage/budget-policy.js';
import type { BudgetEvaluation } from '../usage/budget-policy.js';
import type { CostControlsConfig } from '../config/types.js';
import type { UsageEventInput, PricingResult } from '../usage/types.js';

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
  estimatedCostUsd: 0.50,
  pricingStatus: 'priced',
};

/** Insert an event and override its createdAt timestamp. */
function insertEventAt(
  createdAt: number,
  pricing: PricingResult = pricedResult,
): void {
  const event = recordUsageEvent(makeInput(), pricing);
  const db = getDb();
  db.run(`UPDATE llm_usage_events SET created_at = ${createdAt} WHERE id = '${event.id}'`);
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BASE_DATE = new Date('2025-01-15T12:00:00Z').getTime();

describe('evaluateBudgets', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM llm_usage_events');
  });

  test('returns empty violations when costControls is disabled', () => {
    const config: CostControlsConfig = {
      enabled: false,
      budgets: [{ period: 'day', amountUsd: 1.0, action: 'block' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(0);
    expect(result.hasWarnings).toBe(false);
    expect(result.hasBlocks).toBe(false);
  });

  test('returns empty violations when no budget rules defined', () => {
    const config: CostControlsConfig = {
      enabled: true,
      budgets: [],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(0);
    expect(result.hasWarnings).toBe(false);
    expect(result.hasBlocks).toBe(false);
  });

  test('reports no exceeded when spend is under budget', () => {
    // Insert $0.50 spend, budget is $5.00
    insertEventAt(BASE_DATE - HOUR_MS);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'day', amountUsd: 5.0, action: 'warn' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(false);
    expect(result.violations[0].currentSpend).toBe(0.50);
    expect(result.violations[0].amountUsd).toBe(5.0);
    expect(result.violations[0].action).toBe('warn');
    expect(result.hasWarnings).toBe(false);
    expect(result.hasBlocks).toBe(false);
  });

  test('detects exceeded warn budget', () => {
    // Insert 3 events ($0.50 each = $1.50), budget is $1.00
    insertEventAt(BASE_DATE - HOUR_MS);
    insertEventAt(BASE_DATE - HOUR_MS * 2);
    insertEventAt(BASE_DATE - HOUR_MS * 3);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'day', amountUsd: 1.0, action: 'warn' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(true);
    expect(result.violations[0].currentSpend).toBe(1.50);
    expect(result.violations[0].action).toBe('warn');
    expect(result.hasWarnings).toBe(true);
    expect(result.hasBlocks).toBe(false);
  });

  test('detects exceeded block budget', () => {
    // Insert 3 events ($0.50 each = $1.50), budget is $1.00
    insertEventAt(BASE_DATE - HOUR_MS);
    insertEventAt(BASE_DATE - HOUR_MS * 2);
    insertEventAt(BASE_DATE - HOUR_MS * 3);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'day', amountUsd: 1.0, action: 'block' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(true);
    expect(result.violations[0].action).toBe('block');
    expect(result.hasWarnings).toBe(false);
    expect(result.hasBlocks).toBe(true);
  });

  test('evaluates multiple periods independently', () => {
    // Insert 1 event 2 hours ago ($0.50) — within day and week windows
    insertEventAt(BASE_DATE - HOUR_MS * 2);

    // Insert 1 event 3 days ago ($0.50) — within week window only
    insertEventAt(BASE_DATE - DAY_MS * 3);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [
        { period: 'day', amountUsd: 0.40, action: 'warn' },
        { period: 'week', amountUsd: 0.80, action: 'block' },
      ],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(2);

    const dayViolation = result.violations.find((v) => v.period === 'day')!;
    expect(dayViolation.exceeded).toBe(true);
    expect(dayViolation.currentSpend).toBe(0.50);
    expect(dayViolation.action).toBe('warn');

    const weekViolation = result.violations.find((v) => v.period === 'week')!;
    expect(weekViolation.exceeded).toBe(true);
    expect(weekViolation.currentSpend).toBe(1.0);
    expect(weekViolation.action).toBe('block');

    expect(result.hasWarnings).toBe(true);
    expect(result.hasBlocks).toBe(true);
  });

  test('month period covers last 30 days', () => {
    // Insert event 25 days ago — within 30-day month window
    insertEventAt(BASE_DATE - DAY_MS * 25);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'month', amountUsd: 0.40, action: 'warn' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(true);
    expect(result.violations[0].currentSpend).toBe(0.50);
    expect(result.violations[0].period).toBe('month');
  });

  test('events outside the window are not counted', () => {
    // Insert event 2 days ago — outside the day window
    insertEventAt(BASE_DATE - DAY_MS * 2);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'day', amountUsd: 0.10, action: 'block' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(false);
    expect(result.violations[0].currentSpend).toBe(0);
  });

  test('exact budget amount counts as exceeded', () => {
    // Insert exactly $0.50, budget is $0.50
    insertEventAt(BASE_DATE - HOUR_MS);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [{ period: 'day', amountUsd: 0.50, action: 'warn' }],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].exceeded).toBe(true);
  });

  test('mixed warn and block with partial exceedance', () => {
    // Insert $0.50 within last day
    insertEventAt(BASE_DATE - HOUR_MS);

    const config: CostControlsConfig = {
      enabled: true,
      budgets: [
        { period: 'day', amountUsd: 0.40, action: 'warn' },   // exceeded
        { period: 'day', amountUsd: 1.00, action: 'block' },  // not exceeded
      ],
    };

    const result = evaluateBudgets(config, BASE_DATE);
    expect(result.violations).toHaveLength(2);

    const warnViolation = result.violations.find((v) => v.action === 'warn')!;
    expect(warnViolation.exceeded).toBe(true);

    const blockViolation = result.violations.find((v) => v.action === 'block')!;
    expect(blockViolation.exceeded).toBe(false);

    expect(result.hasWarnings).toBe(true);
    expect(result.hasBlocks).toBe(false);
  });
});
