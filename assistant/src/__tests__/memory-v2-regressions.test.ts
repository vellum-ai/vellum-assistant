import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'memory-v2-regressions-'));

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

import { and, eq } from 'drizzle-orm';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { requestMemoryBackfill } from '../memory/admin.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { selectEmbeddingBackend } from '../memory/embedding-backend.js';
import { indexMessageNow } from '../memory/indexer.js';
import { extractAndUpsertMemoryItemsForMessage } from '../memory/items-extractor.js';
import { enqueueMemoryJob } from '../memory/jobs-store.js';
import { currentWeekWindow, runMemoryJobsOnce } from '../memory/jobs-worker.js';
import {
  buildMemoryRecall,
  injectMemoryRecallIntoUserMessage,
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import { conversations, memoryItems, memoryJobs, messages } from '../memory/schema.js';

describe('Memory V2 regressions', () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_sources');
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

  test('lexical recall accepts punctuation-heavy user queries without degrading', async () => {
    const db = getDb();
    const createdAt = 1_700_000_000_000;
    db.insert(conversations).values({
      id: 'conv-1',
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();
    db.insert(messages).values({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'error timeout in src index ts' }]),
      createdAt,
    }).run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES (
        'seg-1', 'msg-1', 'conv-1', 'user', 0, 'error timeout in src index ts', 8, ${createdAt}, ${createdAt}
      )
    `);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall('error: timeout src/index.ts foo-bar', 'conv-1', config);
    expect(recall.degraded).toBe(false);
    expect(recall.lexicalHits).toBeGreaterThan(0);
  });

  test('recall excludes current-turn message ids from injected candidates', async () => {
    const db = getDb();
    const now = 1_700_000_100_000;
    db.insert(conversations).values({
      id: 'conv-exclude',
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
    db.insert(messages).values({
      id: 'msg-old',
      conversationId: 'conv-exclude',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Remember my timezone is PST.' }]),
      createdAt: now - 10_000,
    }).run();
    db.insert(messages).values({
      id: 'msg-current',
      conversationId: 'conv-exclude',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'What is my timezone again?' }]),
      createdAt: now,
    }).run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES
      ('seg-old', 'msg-old', 'conv-exclude', 'user', 0, 'Remember my timezone is PST.', 7, ${now - 10_000}, ${now - 10_000}),
      ('seg-current', 'msg-current', 'conv-exclude', 'user', 0, 'What is my timezone again?', 7, ${now}, ${now})
    `);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall(
      'timezone',
      'conv-exclude',
      config,
      { excludeMessageIds: ['msg-current'] },
    );
    expect(recall.injectedText).toContain('[segment:seg-old]');
    expect(recall.injectedText).not.toContain('[segment:seg-current]');
  });

  test('memory recall injection remains user-role and is stripped from runtime history', () => {
    const originalUserMessage = {
      role: 'user' as const,
      content: [{ type: 'text', text: 'Actual user request' }],
    };
    const injected = injectMemoryRecallIntoUserMessage(
      originalUserMessage,
      '[Memory Recall v1]\n- [item:abc] user prefers concise answers',
    );

    expect(injected.role).toBe('user');
    expect(injected.content[0]).toEqual({
      type: 'text',
      text: '[Memory Recall v1]\n- [item:abc] user prefers concise answers',
    });

    const cleaned = stripMemoryRecallMessages([injected]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toEqual(originalUserMessage);
  });

  test('memory item lastSeenAt follows message.createdAt and does not move backwards', () => {
    const db = getDb();
    db.insert(conversations).values({
      id: 'conv-2',
      title: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();

    db.insert(messages).values({
      id: 'msg-newer',
      conversationId: 'conv-2',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'We decided to use sqlite for local persistence because reliability matters.' }]),
      createdAt: 1_000,
    }).run();
    db.insert(messages).values({
      id: 'msg-older',
      conversationId: 'conv-2',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'We decided to use sqlite for local persistence because reliability matters.' }]),
      createdAt: 500,
    }).run();

    extractAndUpsertMemoryItemsForMessage('msg-newer');
    extractAndUpsertMemoryItemsForMessage('msg-older');

    const row = db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.kind, 'decision'), eq(memoryItems.status, 'active')))
      .get();

    expect(row).not.toBeNull();
    expect(row?.lastSeenAt).toBe(1_000);
  });

  test('indexing no longer enqueues segment embedding jobs', () => {
    const db = getDb();
    const createdAt = 2_000;
    db.insert(conversations).values({
      id: 'conv-index',
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();
    db.insert(messages).values({
      id: 'msg-index',
      conversationId: 'conv-index',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Please remember this implementation detail.' }]),
      createdAt,
    }).run();

    const result = indexMessageNow({
      messageId: 'msg-index',
      conversationId: 'conv-index',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Please remember this implementation detail.' }]),
      createdAt,
    }, DEFAULT_CONFIG.memory);
    expect(result.enqueuedJobs).toBe(2);

    const embedSegmentJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, 'embed_segment'))
      .all();
    expect(embedSegmentJobs).toHaveLength(0);
  });

  test('embed jobs are skipped (not failed) when no embedding backend is configured', async () => {
    const db = getDb();
    const now = 3_000;
    db.insert(memoryItems).values({
      id: 'item-no-backend',
      kind: 'fact',
      subject: 'backend',
      statement: 'No embedding backend configured in test',
      status: 'active',
      confidence: 0.8,
      fingerprint: 'item-no-backend-fingerprint',
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
    }).run();
    const jobId = enqueueMemoryJob('embed_item', { itemId: 'item-no-backend' });

    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    const row = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .get();
    expect(row?.status).toBe('completed');
  });

  test('weekly window uses UTC boundaries for stable scope keys', () => {
    const window = currentWeekWindow(new Date('2025-01-06T00:30:00.000Z'));
    expect(window.scopeKey).toBe('2025-W02');
    expect(window.startMs).toBe(Date.parse('2025-01-06T00:00:00.000Z'));
    expect(window.endMs).toBe(Date.parse('2025-01-13T00:00:00.000Z'));
  });

  test('explicit ollama memory embedding provider is honored without extra ollama config', () => {
    const config = {
      ...DEFAULT_CONFIG,
      provider: 'anthropic' as const,
      apiKeys: {},
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: 'ollama' as const,
        },
      },
    };

    const selection = selectEmbeddingBackend(config);
    expect(selection.backend?.provider).toBe('ollama');
    expect(selection.reason).toBeNull();
  });

  test('memory backfill request resumes by default and only restarts when forced', () => {
    const db = getDb();
    const resumeJobId = requestMemoryBackfill();
    const forceJobId = requestMemoryBackfill(true);

    const resumeRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, resumeJobId))
      .get();
    const forceRow = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, forceJobId))
      .get();

    expect(resumeRow).not.toBeNull();
    expect(forceRow).not.toBeNull();
    expect(JSON.parse(resumeRow?.payload ?? '{}')).toMatchObject({ force: false });
    expect(JSON.parse(forceRow?.payload ?? '{}')).toMatchObject({ force: true });
  });

  test('memory recall token budgeting includes recall marker overhead', async () => {
    const db = getDb();
    const createdAt = 1_700_000_300_000;
    db.insert(conversations).values({
      id: 'conv-budget',
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();
    db.insert(messages).values({
      id: 'msg-budget',
      conversationId: 'conv-budget',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'remember budget token sentinel' }]),
      createdAt,
    }).run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES (
        'seg-budget', 'msg-budget', 'conv-budget', 'user', 0, 'remember budget token sentinel', 6, ${createdAt}, ${createdAt}
      )
    `);

    const candidateLine = '- [segment:seg-budget] remember budget token sentinel';
    const lineOnlyTokens = estimateTextTokens(candidateLine);
    const fullRecallTokens = estimateTextTokens(`[Memory Recall v1]\n${candidateLine}`);
    expect(fullRecallTokens).toBeGreaterThan(lineOnlyTokens);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          maxInjectTokens: lineOnlyTokens,
        },
      },
    };

    const recall = await buildMemoryRecall('budget sentinel', 'conv-budget', config);
    expect(recall.injectedText).toBe('');
    expect(recall.injectedTokens).toBe(0);
  });
});
