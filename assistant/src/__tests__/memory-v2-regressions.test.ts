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
import { getRecentSegmentsForConversation, indexMessageNow } from '../memory/indexer.js';
import { extractAndUpsertMemoryItemsForMessage } from '../memory/items-extractor.js';
import { claimMemoryJobs, enqueueMemoryJob } from '../memory/jobs-store.js';
import { currentWeekWindow, runMemoryJobsOnce } from '../memory/jobs-worker.js';
import {
  buildMemoryRecall,
  injectMemoryRecallIntoUserMessage,
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import {
  conversations,
  memoryEmbeddings,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  memorySummaries,
  messages,
} from '../memory/schema.js';

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

  async function withMockOllamaQueryEmbedding<T>(run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => (
      new Response(
        JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    )) as unknown as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function semanticRecallConfig() {
    return {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: 'ollama' as const,
          required: true,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          lexicalTopK: 0,
          semanticTopK: 10,
          maxInjectTokens: 2000,
        },
      },
    };
  }

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

  test('semantic recall excludes items backed only by excluded message ids', async () => {
    const db = getDb();
    const now = 1_700_000_120_000;
    db.insert(conversations).values({
      id: 'conv-semantic-exclude',
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
    db.insert(messages).values([
      {
        id: 'msg-semantic-old',
        conversationId: 'conv-semantic-exclude',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'Timezone is PST.' }]),
        createdAt: now - 10_000,
      },
      {
        id: 'msg-semantic-current',
        conversationId: 'conv-semantic-exclude',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'Remember timezone PST for this turn.' }]),
        createdAt: now,
      },
    ]).run();
    db.insert(memoryItems).values([
      {
        id: 'item-semantic-old',
        kind: 'fact',
        subject: 'timezone',
        statement: 'User timezone is PST',
        status: 'active',
        confidence: 0.9,
        fingerprint: 'item-semantic-old-fingerprint',
        firstSeenAt: now - 10_000,
        lastSeenAt: now - 10_000,
        lastUsedAt: null,
      },
      {
        id: 'item-semantic-current',
        kind: 'fact',
        subject: 'timezone',
        statement: 'User timezone is PST (current turn)',
        status: 'active',
        confidence: 0.9,
        fingerprint: 'item-semantic-current-fingerprint',
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      },
    ]).run();
    db.insert(memoryItemSources).values([
      {
        memoryItemId: 'item-semantic-old',
        messageId: 'msg-semantic-old',
        evidence: 'old source',
        createdAt: now - 10_000,
      },
      {
        memoryItemId: 'item-semantic-current',
        messageId: 'msg-semantic-current',
        evidence: 'current turn source',
        createdAt: now,
      },
    ]).run();
    db.insert(memoryEmbeddings).values([
      {
        id: 'emb-semantic-old',
        targetType: 'item',
        targetId: 'item-semantic-old',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'emb-semantic-current',
        targetType: 'item',
        targetId: 'item-semantic-current',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const recall = await withMockOllamaQueryEmbedding(() => (
      buildMemoryRecall(
        'timezone',
        'conv-semantic-exclude',
        semanticRecallConfig(),
        { excludeMessageIds: ['msg-semantic-current'] },
      )
    ));
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain('[item:item-semantic-old]');
    expect(recall.injectedText).not.toContain('[item:item-semantic-current]');
  });

  test('semantic recall skips active items that have no remaining evidence rows', async () => {
    const db = getDb();
    const now = 1_700_000_130_000;
    db.insert(conversations).values({
      id: 'conv-semantic-evidence',
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
      id: 'msg-semantic-evidence',
      conversationId: 'conv-semantic-evidence',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Timezone is PST.' }]),
      createdAt: now,
    }).run();
    db.insert(memoryItems).values([
      {
        id: 'item-semantic-with-evidence',
        kind: 'fact',
        subject: 'timezone',
        statement: 'User timezone is PST',
        status: 'active',
        confidence: 0.9,
        fingerprint: 'item-semantic-with-evidence-fingerprint',
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      },
      {
        id: 'item-semantic-orphan',
        kind: 'fact',
        subject: 'timezone',
        statement: 'Stale orphan fact',
        status: 'active',
        confidence: 0.9,
        fingerprint: 'item-semantic-orphan-fingerprint',
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      },
    ]).run();
    db.insert(memoryItemSources).values({
      memoryItemId: 'item-semantic-with-evidence',
      messageId: 'msg-semantic-evidence',
      evidence: 'message evidence',
      createdAt: now,
    }).run();
    db.insert(memoryEmbeddings).values([
      {
        id: 'emb-semantic-with-evidence',
        targetType: 'item',
        targetId: 'item-semantic-with-evidence',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'emb-semantic-orphan',
        targetType: 'item',
        targetId: 'item-semantic-orphan',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const recall = await withMockOllamaQueryEmbedding(() => (
      buildMemoryRecall(
        'timezone',
        'conv-semantic-evidence',
        semanticRecallConfig(),
      )
    ));
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain('[item:item-semantic-with-evidence]');
    expect(recall.injectedText).not.toContain('[item:item-semantic-orphan]');
  });

  test('semantic recall excludes conversation summaries that overlap excluded messages', async () => {
    const db = getDb();
    const now = 1_700_000_140_000;
    const conversationId = 'conv-semantic-summary';
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
    db.insert(messages).values({
      id: 'msg-semantic-summary-excluded',
      conversationId,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'This is the current turn message.' }]),
      createdAt: now,
    }).run();
    db.insert(memorySummaries).values([
      {
        id: 'summary-semantic-conversation',
        scope: 'conversation',
        scopeKey: conversationId,
        summary: 'Conversation summary containing current turn details',
        tokenEstimate: 12,
        startAt: now - 500,
        endAt: now + 500,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'summary-semantic-weekly',
        scope: 'weekly_global',
        scopeKey: '2026-W07',
        summary: 'Weekly summary that should remain eligible',
        tokenEstimate: 12,
        startAt: now - 10_000,
        endAt: now + 10_000,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();
    db.insert(memoryEmbeddings).values([
      {
        id: 'emb-summary-semantic-conversation',
        targetType: 'summary',
        targetId: 'summary-semantic-conversation',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'emb-summary-semantic-weekly',
        targetType: 'summary',
        targetId: 'summary-semantic-weekly',
        provider: 'ollama',
        model: DEFAULT_CONFIG.memory.embeddings.ollamaModel,
        dimensions: 3,
        vectorJson: JSON.stringify([1, 0, 0]),
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const recall = await withMockOllamaQueryEmbedding(() => (
      buildMemoryRecall(
        'summary',
        conversationId,
        semanticRecallConfig(),
        { excludeMessageIds: ['msg-semantic-summary-excluded'] },
      )
    ));
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).not.toContain('[summary:summary-semantic-conversation]');
    expect(recall.injectedText).toContain('[summary:summary-semantic-weekly]');
  });

  test('memory recall injection remains user-role and is stripped from runtime history', () => {
    const memoryRecallText = '[Memory Recall v1]\n- [item:abc] user prefers concise answers';
    const originalUserMessage = {
      role: 'user' as const,
      content: [{ type: 'text', text: 'Actual user request' }],
    };
    const injected = injectMemoryRecallIntoUserMessage(
      originalUserMessage,
      memoryRecallText,
    );

    expect(injected.role).toBe('user');
    expect(injected.content[0]).toEqual({
      type: 'text',
      text: memoryRecallText,
    });

    const cleaned = stripMemoryRecallMessages([injected], memoryRecallText);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toEqual(originalUserMessage);
  });

  test('memory recall stripping preserves literal marker text outside the injected block', () => {
    const memoryRecallText = '[Memory Recall v1]\n- [item:abc] user prefers concise answers';
    const literalUserMessage = {
      role: 'user' as const,
      content: [{ type: 'text', text: '[Memory Recall v1] this is user-authored content' }],
    };
    const literalAssistantMessage = {
      role: 'assistant' as const,
      content: [{ type: 'text', text: memoryRecallText }],
    };
    const originalUserTail = {
      role: 'user' as const,
      content: [{ type: 'text', text: 'Actual user request' }],
    };
    const injectedTail = injectMemoryRecallIntoUserMessage(originalUserTail, memoryRecallText);

    const cleaned = stripMemoryRecallMessages(
      [literalUserMessage, literalAssistantMessage, injectedTail],
      memoryRecallText,
    );

    expect(cleaned).toHaveLength(3);
    expect(cleaned[0]).toEqual(literalUserMessage);
    expect(cleaned[1]).toEqual(literalAssistantMessage);
    expect(cleaned[2]).toEqual(originalUserTail);
  });

  test('aborting memory recall embedding returns a non-degraded aborted recall result', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;

    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          reject(new Error('Expected abort signal'));
          return;
        }
        const abortError = new Error('Aborted');
        abortError.name = 'AbortError';
        if (signal.aborted) {
          reject(abortError);
          return;
        }
        signal.addEventListener('abort', () => reject(abortError), { once: true });
      });
    }) as typeof globalThis.fetch;

    try {
      const recallPromise = buildMemoryRecall(
        'timezone',
        'conv-abort',
        semanticRecallConfig(),
        { signal: controller.signal },
      );
      controller.abort();
      const recall = await recallPromise;
      expect(seenSignal).toBe(controller.signal);
      expect(recall.degraded).toBe(false);
      expect(recall.reason).toBe('memory.aborted');
      expect(recall.injectedText).toBe('');
      expect(recall.injectedTokens).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test('indexing skips durable item extraction for non-user messages', () => {
    const db = getDb();
    const createdAt = 2_100;
    db.insert(conversations).values({
      id: 'conv-assistant-index',
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
      id: 'msg-assistant-index',
      conversationId: 'conv-assistant-index',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'I think your timezone is PST.' }]),
      createdAt,
    }).run();

    const result = indexMessageNow({
      messageId: 'msg-assistant-index',
      conversationId: 'conv-assistant-index',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'I think your timezone is PST.' }]),
      createdAt,
    }, DEFAULT_CONFIG.memory);
    expect(result.enqueuedJobs).toBe(1);

    const extractionJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, 'extract_items'))
      .all();
    expect(extractionJobs).toHaveLength(0);
  });

  test('recent segment helper returns newest segments first', () => {
    const db = getDb();
    db.insert(conversations).values({
      id: 'conv-recent',
      title: null,
      createdAt: 2_200,
      updatedAt: 2_200,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();
    db.insert(messages).values([
      {
        id: 'msg-recent-1',
        conversationId: 'conv-recent',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'old' }]),
        createdAt: 2_201,
      },
      {
        id: 'msg-recent-2',
        conversationId: 'conv-recent',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'newer' }]),
        createdAt: 2_202,
      },
      {
        id: 'msg-recent-3',
        conversationId: 'conv-recent',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'newest' }]),
        createdAt: 2_203,
      },
    ]).run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES
      ('seg-recent-1', 'msg-recent-1', 'conv-recent', 'user', 0, 'old', 1, 2201, 2201),
      ('seg-recent-2', 'msg-recent-2', 'conv-recent', 'user', 0, 'newer', 1, 2202, 2202),
      ('seg-recent-3', 'msg-recent-3', 'conv-recent', 'user', 0, 'newest', 1, 2203, 2203)
    `);

    const recent = getRecentSegmentsForConversation('conv-recent', 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.id).toBe('seg-recent-3');
    expect(recent[1]?.id).toBe('seg-recent-2');
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

  test('claimMemoryJobs only returns rows it actually claimed', () => {
    const db = getDb();
    const jobId = enqueueMemoryJob('build_conversation_summary', { conversationId: 'conv-lock' });
    db.run(`
      CREATE TEMP TRIGGER memory_jobs_claim_ignore
      BEFORE UPDATE ON memory_jobs
      WHEN NEW.status = 'running' AND OLD.id = '${jobId}'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    try {
      const claimed = claimMemoryJobs(10);
      expect(claimed).toHaveLength(0);
      const row = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.id, jobId))
        .get();
      expect(row?.status).toBe('pending');
    } finally {
      db.run('DROP TRIGGER IF EXISTS memory_jobs_claim_ignore');
    }
  });
});
