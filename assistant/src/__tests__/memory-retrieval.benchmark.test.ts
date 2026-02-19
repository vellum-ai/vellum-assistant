/**
 * Memory Retrieval Benchmark
 *
 * Measures end-to-end memory recall time with varying database sizes.
 * Validates latency stays within acceptable bounds and token budget
 * enforcement works correctly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'mem-retrieval-bench-'));

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

import { DEFAULT_CONFIG } from '../config/defaults.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { buildMemoryRecall } from '../memory/retriever.js';
import { conversations, memorySegments, messages } from '../memory/schema.js';
import type { AssistantConfig } from '../config/types.js';

function seedMemoryItems(conversationId: string, count: number, now: number): void {
  const db = getDb();
  db.insert(conversations).values({
    id: conversationId,
    title: null,
    createdAt: now,
    updatedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
  }).run();

  for (let i = 0; i < count; i++) {
    const msgId = `msg-${conversationId}-${i}`;
    const text = `Memory item ${i}: information about topic-${i % 20} including keyword-${i % 10} details.`;
    db.insert(messages).values({
      id: msgId,
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: JSON.stringify([{ type: 'text', text }]),
      createdAt: now + i,
    }).run();
    db.insert(memorySegments).values({
      id: `seg-${conversationId}-${i}`,
      messageId: msgId,
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      segmentIndex: 0,
      text,
      tokenEstimate: 20,
      scopeId: 'default',
      createdAt: now + i,
      updatedAt: now + i,
    }).run();
  }
}

function makeConfig(overrides?: { maxInjectTokens?: number }): AssistantConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      embeddings: {
        ...DEFAULT_CONFIG.memory.embeddings,
        provider: 'openai' as const,
        required: false,
      },
      retrieval: {
        ...DEFAULT_CONFIG.memory.retrieval,
        lexicalTopK: 50,
        semanticTopK: 20,
        maxInjectTokens: overrides?.maxInjectTokens ?? 750,
        reranking: { ...DEFAULT_CONFIG.memory.retrieval.reranking, enabled: false },
        dynamicBudget: {
          enabled: false,
          minInjectTokens: 160,
          maxInjectTokens: overrides?.maxInjectTokens ?? 750,
          targetHeadroomTokens: 900,
        },
      },
    },
  };
}

describe('Memory retrieval benchmark', () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_sources');
    db.run('DELETE FROM memory_item_entities');
    db.run('DELETE FROM memory_entity_relations');
    db.run('DELETE FROM memory_entities');
    db.run('DELETE FROM memory_embeddings');
    db.run('DELETE FROM memory_summaries');
    db.run('DELETE FROM memory_items');
    db.run('DELETE FROM memory_segment_fts');
    db.run('DELETE FROM memory_segments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM memory_jobs');
    db.run('DELETE FROM memory_checkpoints');
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test('retrieval completes under 100ms for 100 items', async () => {
    const conversationId = 'conv-bench-100';
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 100, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    expect(recall.lexicalHits).toBeGreaterThan(0);
    expect(recall.selectedCount).toBeGreaterThan(0);
    expect(recall.latencyMs).toBeLessThan(100);
  });

  test('retrieval completes under 200ms for 500 items', async () => {
    const conversationId = 'conv-bench-500';
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 500, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    expect(recall.lexicalHits).toBeGreaterThan(0);
    expect(recall.selectedCount).toBeGreaterThan(0);
    expect(recall.latencyMs).toBeLessThan(200);
  });

  test('retrieval completes under 500ms for 2000 items', async () => {
    const conversationId = 'conv-bench-2000';
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 2000, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    expect(recall.lexicalHits).toBeGreaterThan(0);
    expect(recall.selectedCount).toBeGreaterThan(0);
    expect(recall.latencyMs).toBeLessThan(500);
  });

  test('token budget enforcement: maxInjectTokens is respected', async () => {
    const conversationId = 'conv-bench-budget';
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 500, now);

    const smallBudget = 200;
    const config = makeConfig({ maxInjectTokens: smallBudget });
    const recall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.injectedTokens).toBeLessThanOrEqual(smallBudget);
    expect(recall.injectedTokens).toBeGreaterThan(0);

    // Compare against a larger budget to verify the cap actually constrains
    const largeBudget = 2000;
    const largeConfig = makeConfig({ maxInjectTokens: largeBudget });
    const largeRecall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      largeConfig,
    );

    expect(largeRecall.injectedTokens).toBeLessThanOrEqual(largeBudget);
    // With more budget, we should get at least as many tokens
    expect(largeRecall.injectedTokens).toBeGreaterThanOrEqual(recall.injectedTokens);
  });

  test('early termination reduces latency when applicable', async () => {
    const conversationId = 'conv-bench-et';
    const now = 1_700_500_000_000;
    // Seed enough items that early termination can trigger
    seedMemoryItems(conversationId, 500, now);

    // Config with early termination enabled and low thresholds to trigger it
    const etConfig: AssistantConfig = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: 'openai' as const,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          lexicalTopK: 50,
          semanticTopK: 20,
          maxInjectTokens: 750,
          reranking: { ...DEFAULT_CONFIG.memory.retrieval.reranking, enabled: false },
          dynamicBudget: {
            enabled: false,
            minInjectTokens: 160,
            maxInjectTokens: 750,
            targetHeadroomTokens: 900,
          },
          earlyTermination: {
            enabled: true,
            minCandidates: 5,
            minHighConfidence: 3,
            confidenceThreshold: 0.3,
          },
        },
      },
    };

    const recall = await buildMemoryRecall(
      'What do we know about topic-5 and keyword-3?',
      conversationId,
      etConfig,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.earlyTerminated).toBe(true);
    // Semantic search should be skipped when early termination fires
    expect(recall.semanticHits).toBe(0);
    expect(recall.selectedCount).toBeGreaterThan(0);
  });
});
