import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'llm-usage-store-test-'));

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
import { recordUsageEvent, listUsageEvents } from '../memory/llm-usage-store.js';
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

describe('recordUsageEvent', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test('persists an event and returns it with id and createdAt', () => {
    const input = makeInput();
    const event = recordUsageEvent(input, pricedResult);

    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.createdAt).toBeDefined();
    expect(typeof event.createdAt).toBe('number');
    expect(event.provider).toBe('anthropic');
    expect(event.model).toBe('claude-sonnet-4-20250514');
    expect(event.inputTokens).toBe(1000);
    expect(event.outputTokens).toBe(500);
    expect(event.actor).toBe('main_agent');
    expect(event.estimatedCostUsd).toBe(0.0045);
    expect(event.pricingStatus).toBe('priced');
  });

  test('persists a priced event that can be retrieved', () => {
    const input = makeInput({ conversationId: 'c1' });
    const event = recordUsageEvent(input, pricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    expect(events[0].estimatedCostUsd).toBe(0.0045);
    expect(events[0].pricingStatus).toBe('priced');
    expect(events[0].conversationId).toBe('c1');
  });

  test('persists an unpriced event', () => {
    const input = makeInput({ provider: 'ollama', model: 'llama3' });
    const event = recordUsageEvent(input, unpricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    expect(events[0].estimatedCostUsd).toBeNull();
    expect(events[0].pricingStatus).toBe('unpriced');
    expect(events[0].provider).toBe('ollama');
    expect(events[0].model).toBe('llama3');
  });

  test('handles null optional fields', () => {
    const input = makeInput({
      conversationId: null,
      runId: null,
      requestId: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    });
    const _event = recordUsageEvent(input, unpricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBeNull();
    expect(events[0].runId).toBeNull();
    expect(events[0].requestId).toBeNull();
    expect(events[0].cacheCreationInputTokens).toBeNull();
    expect(events[0].cacheReadInputTokens).toBeNull();
  });

  test('handles populated optional fields', () => {
    const input = makeInput({
      conversationId: 'conv-1',
      runId: 'run-1',
      requestId: 'req-1',
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    });
    const _event = recordUsageEvent(input, pricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBe('conv-1');
    expect(events[0].runId).toBe('run-1');
    expect(events[0].requestId).toBe('req-1');
    expect(events[0].cacheCreationInputTokens).toBe(200);
    expect(events[0].cacheReadInputTokens).toBe(300);
  });
});

describe('listUsageEvents', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM llm_usage_events`);
  });

  test('returns events in descending createdAt order', () => {
    // Insert events with small delays to ensure different timestamps
    const event1 = recordUsageEvent(makeInput({ model: 'model-a' }), pricedResult);
    // Manually adjust createdAt for deterministic ordering
    const db = getDb();
    db.run(`UPDATE llm_usage_events SET created_at = 1000 WHERE id = '${event1.id}'`);

    const event2 = recordUsageEvent(makeInput({ model: 'model-b' }), pricedResult);
    db.run(`UPDATE llm_usage_events SET created_at = 2000 WHERE id = '${event2.id}'`);

    const event3 = recordUsageEvent(makeInput({ model: 'model-c' }), pricedResult);
    db.run(`UPDATE llm_usage_events SET created_at = 3000 WHERE id = '${event3.id}'`);

    const events = listUsageEvents();
    expect(events).toHaveLength(3);
    expect(events[0].model).toBe('model-c');
    expect(events[1].model).toBe('model-b');
    expect(events[2].model).toBe('model-a');
  });

  test('respects the limit option', () => {
    recordUsageEvent(makeInput({ model: 'model-a' }), pricedResult);
    recordUsageEvent(makeInput({ model: 'model-b' }), pricedResult);
    recordUsageEvent(makeInput({ model: 'model-c' }), pricedResult);

    const events = listUsageEvents({ limit: 2 });
    expect(events).toHaveLength(2);
  });

  test('defaults to limit of 100', () => {
    // Just verify it returns without error when no limit is specified
    const events = listUsageEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  test('returns empty array when no events exist', () => {
    const events = listUsageEvents();
    expect(events).toHaveLength(0);
  });

  test('returns events with correct types', () => {
    recordUsageEvent(makeInput({
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
    }), pricedResult);

    const events = listUsageEvents();
    expect(events).toHaveLength(1);
    const event = events[0];

    // Verify all fields have correct types
    expect(typeof event.id).toBe('string');
    expect(typeof event.createdAt).toBe('number');
    expect(typeof event.actor).toBe('string');
    expect(typeof event.provider).toBe('string');
    expect(typeof event.model).toBe('string');
    expect(typeof event.inputTokens).toBe('number');
    expect(typeof event.outputTokens).toBe('number');
    expect(typeof event.cacheCreationInputTokens).toBe('number');
    expect(typeof event.cacheReadInputTokens).toBe('number');
    expect(typeof event.estimatedCostUsd).toBe('number');
    expect(typeof event.pricingStatus).toBe('string');
  });
});
