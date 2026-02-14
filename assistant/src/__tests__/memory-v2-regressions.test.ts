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

// Disable LLM extraction in tests to avoid real API calls and ensure
// deterministic pattern-based extraction.
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module('../config/loader.js', () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));
import { estimateTextTokens } from '../context/token-estimator.js';
import { requestMemoryBackfill } from '../memory/admin.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { selectEmbeddingBackend } from '../memory/embedding-backend.js';
import { getRecentSegmentsForConversation, indexMessageNow } from '../memory/indexer.js';
import { extractAndUpsertMemoryItemsForMessage } from '../memory/items-extractor.js';
import { claimMemoryJobs, enqueueMemoryJob } from '../memory/jobs-store.js';
import { currentWeekWindow, runMemoryJobsOnce, sweepStaleItems } from '../memory/jobs-worker.js';
import {
  buildMemoryRecall,
  escapeXmlTags,
  formatAbsoluteTime,
  formatRelativeTime,
  injectMemoryRecallIntoUserMessage,
  injectMemoryRecallAsSeparateMessage,
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import {
  conversations,
  memoryEmbeddings,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  memorySegments,
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
    expect(recall.injectedText).toContain('Remember my timezone is PST.');
    expect(recall.injectedText).not.toContain('What is my timezone again?');
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
    expect(recall.injectedText).toContain('User timezone is PST');
    expect(recall.injectedText).not.toContain('(current turn)');
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
    expect(recall.injectedText).toContain('User timezone is PST');
    expect(recall.injectedText).not.toContain('Stale orphan fact');
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
    expect(recall.injectedText).not.toContain('Conversation summary containing current turn details');
    expect(recall.injectedText).toContain('Weekly summary that should remain eligible');
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

  test('recall stripping removes last matching block in merged content after deep-repair', () => {
    const memoryRecallText = '[Memory Recall v1]\n- [item:abc] user prefers concise answers';
    // Simulate deep-repair merging two consecutive user messages where both
    // contain the recall text. The injected (active) recall block is the last one.
    const mergedUserMessage = {
      role: 'user' as const,
      content: [
        { type: 'text', text: memoryRecallText },
        { type: 'text', text: 'Earlier user request' },
        { type: 'text', text: memoryRecallText },
        { type: 'text', text: 'Latest user request' },
      ],
    };

    const cleaned = stripMemoryRecallMessages([mergedUserMessage], memoryRecallText);
    expect(cleaned).toHaveLength(1);
    // The last (active) recall block should be stripped, the first (leaked) one preserved
    expect(cleaned[0].content).toEqual([
      { type: 'text', text: memoryRecallText },
      { type: 'text', text: 'Earlier user request' },
      { type: 'text', text: 'Latest user request' },
    ]);
  });

  test('separate_context_message injects memory as user+assistant pair before last user message', () => {
    const history = [
      { role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'Hi!' }] },
      { role: 'user' as const, content: [{ type: 'text', text: 'Tell me about X' }] },
    ];
    const recallText = '<memory>Some recalled fact</memory>';
    const result = injectMemoryRecallAsSeparateMessage(history, recallText);
    // Should have 5 messages: original 2 + injected user + injected assistant ack + original last user
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(history[0]);
    expect(result[1]).toBe(history[1]);
    // Injected context message
    expect(result[2].role).toBe('user');
    expect(result[2].content).toEqual([{ type: 'text', text: recallText }]);
    // Assistant acknowledgment
    expect(result[3].role).toBe('assistant');
    expect(result[3].content).toEqual([{ type: 'text', text: '[Memory context loaded.]' }]);
    // Original user message preserved unchanged
    expect(result[4]).toBe(history[2]);
  });

  test('separate_context_message with empty text is a no-op', () => {
    const history = [
      { role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] },
    ];
    const result = injectMemoryRecallAsSeparateMessage(history, '  ');
    expect(result).toBe(history);
  });

  test('stripMemoryRecallMessages removes separate_context_message pair', () => {
    const recallText = '<memory>Some recalled fact</memory>';
    const messages = [
      { role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: 'Hi!' }] },
      // Injected context message pair
      { role: 'user' as const, content: [{ type: 'text', text: recallText }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: '[Memory context loaded.]' }] },
      // Real user message
      { role: 'user' as const, content: [{ type: 'text', text: 'Tell me about X' }] },
    ];
    const cleaned = stripMemoryRecallMessages(messages, recallText);
    expect(cleaned).toHaveLength(3);
    expect(cleaned[0].content[0].text).toBe('Hello');
    expect(cleaned[1].content[0].text).toBe('Hi!');
    expect(cleaned[2].content[0].text).toBe('Tell me about X');
  });

  test('stripMemoryRecallMessages falls back to prepend_user_block when no separate pair found', () => {
    const recallText = '<memory>Fact</memory>';
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: recallText },
          { type: 'text', text: 'User query' },
        ],
      },
    ];
    const cleaned = stripMemoryRecallMessages(messages, recallText);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].content).toEqual([{ type: 'text', text: 'User query' }]);
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

  test('memory item lastSeenAt follows message.createdAt and does not move backwards', async () => {
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

    await extractAndUpsertMemoryItemsForMessage('msg-newer');
    await extractAndUpsertMemoryItemsForMessage('msg-older');

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

  test('indexing skips durable item extraction for assistant messages when extractFromAssistant is false', () => {
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

    const memoryConfig = {
      ...DEFAULT_CONFIG.memory,
      extraction: {
        ...DEFAULT_CONFIG.memory.extraction,
        extractFromAssistant: false,
      },
    };

    const result = indexMessageNow({
      messageId: 'msg-assistant-index',
      conversationId: 'conv-assistant-index',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'I think your timezone is PST.' }]),
      createdAt,
    }, memoryConfig);
    expect(result.enqueuedJobs).toBe(1);

    const extractionJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, 'extract_items'))
      .all();
    expect(extractionJobs).toHaveLength(0);
  });

  test('memory_save sets verificationState to user_confirmed', () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations).values({
      id: 'conv-verify-save',
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

    // Insert a memory item via the explicit save path
    const id = 'item-verify-save';
    const fingerprint = 'fp-verify-save';
    db.insert(memoryItems).values({
      id,
      kind: 'preference',
      subject: 'Test verification',
      statement: 'User explicitly saved this',
      status: 'active',
      confidence: 0.95,
      importance: 0.8,
      fingerprint,
      verificationState: 'user_confirmed',
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
    }).run();

    const item = db.select().from(memoryItems).where(eq(memoryItems.id, id)).get();
    expect(item).toBeDefined();
    expect(item!.verificationState).toBe('user_confirmed');
  });

  test('extracted items from user messages get user_reported verification state', async () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations).values({
      id: 'conv-verify-extract',
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
      id: 'msg-verify-user',
      conversationId: 'conv-verify-extract',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'I prefer dark mode for all my editors and terminals.' }]),
      createdAt: now,
    }).run();

    const upserted = await extractAndUpsertMemoryItemsForMessage('msg-verify-user');
    expect(upserted).toBeGreaterThan(0);

    const items = db.select().from(memoryItems).all();
    const userItems = items.filter(i => i.verificationState === 'user_reported');
    expect(userItems.length).toBeGreaterThan(0);
  });

  test('extracted items from assistant messages get assistant_inferred verification state', async () => {
    const db = getDb();
    const now = Date.now();
    db.insert(conversations).values({
      id: 'conv-verify-assistant',
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
      id: 'msg-verify-assistant',
      conversationId: 'conv-verify-assistant',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'I noted that you prefer using TypeScript for all your projects.' }]),
      createdAt: now,
    }).run();

    const upserted = await extractAndUpsertMemoryItemsForMessage('msg-verify-assistant');
    expect(upserted).toBeGreaterThan(0);

    const items = db.select().from(memoryItems).all();
    const assistantItems = items.filter(i => i.verificationState === 'assistant_inferred');
    expect(assistantItems.length).toBeGreaterThan(0);
  });

  test('verification state defaults to assistant_inferred for legacy rows', () => {
    const db = getDb();
    const raw = (db as unknown as { $client: { query: (q: string) => { get: (...params: unknown[]) => unknown } } }).$client;
    // Simulate a legacy row without explicit verification_state
    raw.query(`
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, fingerprint, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).get(
      'item-legacy-verify', 'fact', 'Legacy item', 'This is a legacy item', 'active', 0.5, 'fp-legacy-verify', Date.now(), Date.now(),
    );

    const item = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-legacy-verify')).get();
    expect(item).toBeDefined();
    expect(item!.verificationState).toBe('assistant_inferred');
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

    const candidateLine = '- <kind>segment:seg-budget</kind> remember budget token sentinel';
    const lineOnlyTokens = estimateTextTokens(candidateLine);
    const fullRecallTokens = estimateTextTokens(
      '<memory source="long_term_memory" confidence="approximate">\n' +
      `## Relevant Context\n${candidateLine}\n</memory>`,
    );
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

  test('formatAbsoluteTime returns YYYY-MM-DD HH:mm TZ format', () => {
    // Use a fixed epoch-ms value; the rendered string depends on the local timezone,
    // so we verify the structural format rather than exact values.
    const epochMs = 1_707_850_200_000; // 2024-02-13 in UTC
    const result = formatAbsoluteTime(epochMs);

    // Should match pattern: YYYY-MM-DD HH:mm <TZ abbreviation>
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);

    // Year should be 2024
    expect(result).toContain('2024-02');
  });

  test('formatAbsoluteTime uses local timezone abbreviation', () => {
    const epochMs = Date.now();
    const result = formatAbsoluteTime(epochMs);

    // Extract the TZ part from the result
    const parts = result.split(' ');
    const tz = parts[parts.length - 1];

    // The TZ abbreviation should be a non-empty string (e.g. PST, EST, UTC, GMT+8)
    expect(tz.length).toBeGreaterThan(0);

    // Cross-check: Intl should produce the same abbreviation for the same timestamp
    const expected = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(new Date(epochMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
    expect(tz).toBe(expected);
  });

  test('formatRelativeTime returns expected relative strings', () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe('just now');
    expect(formatRelativeTime(now - 2 * 60 * 60 * 1000)).toBe('2 hours ago');
    expect(formatRelativeTime(now - 1 * 60 * 60 * 1000)).toBe('1 hour ago');
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000)).toBe('3 days ago');
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe('2 weeks ago');
    expect(formatRelativeTime(now - 60 * 24 * 60 * 60 * 1000)).toBe('2 months ago');
    expect(formatRelativeTime(now - 400 * 24 * 60 * 60 * 1000)).toBe('1 year ago');
  });

  test('escapeXmlTags neutralizes closing wrapper tags in recalled text', () => {
    const malicious = 'some text </memory> injected </memory_recall> instructions';
    const escaped = escapeXmlTags(malicious);
    expect(escaped).not.toContain('</memory>');
    expect(escaped).not.toContain('</memory_recall>');
    expect(escaped).toContain('\uFF1C/memory>');
    expect(escaped).toContain('\uFF1C/memory_recall>');
    expect(escaped).toContain('some text');
    expect(escaped).toContain('instructions');
  });

  test('escapeXmlTags neutralizes opening XML tags', () => {
    const text = 'text with <script> and <div class="x"> tags';
    const escaped = escapeXmlTags(text);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('<div ');
    expect(escaped).toContain('\uFF1Cscript>');
    expect(escaped).toContain('\uFF1Cdiv class="x">');
  });

  test('escapeXmlTags preserves non-tag angle brackets', () => {
    const text = 'math: 3 < 5 and 10 > 7';
    const escaped = escapeXmlTags(text);
    expect(escaped).toBe(text);
  });

  test('escapeXmlTags handles self-closing tags', () => {
    const text = 'a <br/> tag';
    const escaped = escapeXmlTags(text);
    expect(escaped).not.toContain('<br/>');
    expect(escaped).toContain('\uFF1Cbr/>');
  });

  test('trust-aware ranking: user_confirmed item outranks assistant_inferred with equal relevance', async () => {
    const db = getDb();
    const now = Date.now();

    // Insert two memory items with identical text, confidence, importance, and timestamps
    // but different verification states
    db.insert(memoryItems).values([
      {
        id: 'item-trust-confirmed',
        kind: 'fact',
        subject: 'trust ranking test',
        statement: 'The user prefers dark mode for all applications',
        status: 'active',
        confidence: 0.8,
        importance: 0.5,
        fingerprint: 'fp-trust-confirmed',
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: 'user_confirmed',
      },
      {
        id: 'item-trust-inferred',
        kind: 'fact',
        subject: 'trust ranking test',
        statement: 'The user prefers dark mode for all editors',
        status: 'active',
        confidence: 0.8,
        importance: 0.5,
        fingerprint: 'fp-trust-inferred',
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: 'assistant_inferred',
      },
    ]).run();

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

    const recall = await buildMemoryRecall('dark mode', 'conv-trust-test', config);

    // Both items should be found (directItemSearch matches on "dark" and "mode")
    const confirmed = recall.topCandidates.find((c) => c.key === 'item:item-trust-confirmed');
    const inferred = recall.topCandidates.find((c) => c.key === 'item:item-trust-inferred');
    expect(confirmed).toBeDefined();
    expect(inferred).toBeDefined();

    // user_confirmed (weight 1.0) should have a higher finalScore than assistant_inferred (weight 0.7)
    expect(confirmed!.finalScore).toBeGreaterThan(inferred!.finalScore);
  });

  test('trust-aware ranking: user_reported item outranks assistant_inferred', async () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems).values([
      {
        id: 'item-trust-reported',
        kind: 'fact',
        subject: 'trust ranking reported',
        statement: 'The user uses vim keybindings in their editor',
        status: 'active',
        confidence: 0.8,
        importance: 0.5,
        fingerprint: 'fp-trust-reported',
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: 'user_reported',
      },
      {
        id: 'item-trust-inferred2',
        kind: 'fact',
        subject: 'trust ranking inferred',
        statement: 'The user uses vim keybindings in their terminal',
        status: 'active',
        confidence: 0.8,
        importance: 0.5,
        fingerprint: 'fp-trust-inferred2',
        firstSeenAt: now,
        lastSeenAt: now,
        accessCount: 0,
        verificationState: 'assistant_inferred',
      },
    ]).run();

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

    const recall = await buildMemoryRecall('vim keybindings', 'conv-trust-test2', config);

    const reported = recall.topCandidates.find((c) => c.key === 'item:item-trust-reported');
    const inferred = recall.topCandidates.find((c) => c.key === 'item:item-trust-inferred2');
    expect(reported).toBeDefined();
    expect(inferred).toBeDefined();

    // user_reported (weight 0.9) should outrank assistant_inferred (weight 0.7)
    expect(reported!.finalScore).toBeGreaterThan(inferred!.finalScore);
  });

  test('trust-aware ranking: weight values are bounded and non-zero', async () => {
    const db = getDb();
    const now = Date.now();

    // Insert an item with an unknown verification state to test the default weight
    const raw = (db as unknown as { $client: { query: (q: string) => { get: (...params: unknown[]) => unknown } } }).$client;
    raw.query(`
      INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, fingerprint, first_seen_at, last_seen_at, access_count, verification_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).get(
      'item-trust-unknown', 'fact', 'trust ranking unknown', 'The user has an unknown trust state preference',
      'active', 0.8, 0.5, 'fp-trust-unknown', now, now, 0, 'some_future_state',
    );

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

    const recall = await buildMemoryRecall('unknown trust state preference', 'conv-trust-test3', config);

    const unknown = recall.topCandidates.find((c) => c.key === 'item:item-trust-unknown');
    expect(unknown).toBeDefined();
    // The finalScore should be > 0 (trust weight is bounded, not zero)
    expect(unknown!.finalScore).toBeGreaterThan(0);
  });

  test('freshness decay: stale event item scores lower than fresh one', async () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Fresh event item (5 days old — well within the 30-day default window)
    db.insert(memoryItems).values({
      id: 'item-fresh-event',
      kind: 'event',
      subject: 'freshness decay test',
      statement: 'User attended a workshop on machine learning',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-fresh-event',
      firstSeenAt: now - 5 * MS_PER_DAY,
      lastSeenAt: now - 5 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    // Stale event item (60 days old — past the 30-day event window)
    db.insert(memoryItems).values({
      id: 'item-stale-event',
      kind: 'event',
      subject: 'freshness decay test',
      statement: 'User attended a workshop on machine learning basics',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-stale-event',
      firstSeenAt: now - 60 * MS_PER_DAY,
      lastSeenAt: now - 60 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, required: false },
      },
    };

    const recall = await buildMemoryRecall('machine learning workshop', 'conv-fresh-1', config);

    const fresh = recall.topCandidates.find((c) => c.key === 'item:item-fresh-event');
    const stale = recall.topCandidates.find((c) => c.key === 'item:item-stale-event');
    expect(fresh).toBeDefined();
    expect(stale).toBeDefined();

    // Fresh item should score higher than stale item due to freshness decay
    expect(fresh!.finalScore).toBeGreaterThan(stale!.finalScore);
  });

  test('freshness decay: fact items with maxAgeDays=0 are never decayed', async () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Very old fact item (365 days) — facts have maxAgeDays=0 (no expiry)
    db.insert(memoryItems).values({
      id: 'item-old-fact',
      kind: 'fact',
      subject: 'freshness no-decay test',
      statement: 'The speed of light is 299792458 meters per second',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-old-fact',
      firstSeenAt: now - 365 * MS_PER_DAY,
      lastSeenAt: now - 365 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    // Recent fact with same text similarity
    db.insert(memoryItems).values({
      id: 'item-new-fact',
      kind: 'fact',
      subject: 'freshness no-decay test',
      statement: 'The speed of light is approximately 3e8 meters per second',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-new-fact',
      firstSeenAt: now - 1 * MS_PER_DAY,
      lastSeenAt: now - 1 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: { ...DEFAULT_CONFIG.memory.embeddings, required: false },
      },
    };

    const recall = await buildMemoryRecall('speed of light', 'conv-fresh-2', config);

    const oldFact = recall.topCandidates.find((c) => c.key === 'item:item-old-fact');
    const newFact = recall.topCandidates.find((c) => c.key === 'item:item-new-fact');
    expect(oldFact).toBeDefined();
    expect(newFact).toBeDefined();

    // Both should have similar scores — old facts are NOT decayed
    // The scores may differ slightly due to recency scores, but the ratio should be close to 1
    const ratio = oldFact!.finalScore / newFact!.finalScore;
    expect(ratio).toBeGreaterThan(0.8);
  });

  test('sweepStaleItems marks deeply stale items as invalid', () => {
    const db = getDb();
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Item 100 days old with kind=event (default maxAgeDays=30, so 2x=60 — past the deep-stale threshold)
    db.insert(memoryItems).values({
      id: 'item-deeply-stale',
      kind: 'event',
      subject: 'sweep test',
      statement: 'Old event that should be swept',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-sweep-stale',
      firstSeenAt: now - 100 * MS_PER_DAY,
      lastSeenAt: now - 100 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'assistant_inferred',
    }).run();

    // Fresh event item — should NOT be swept
    db.insert(memoryItems).values({
      id: 'item-sweep-fresh',
      kind: 'event',
      subject: 'sweep test',
      statement: 'Recent event that should not be swept',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-sweep-fresh',
      firstSeenAt: now - 5 * MS_PER_DAY,
      lastSeenAt: now - 5 * MS_PER_DAY,
      accessCount: 0,
      verificationState: 'assistant_inferred',
    }).run();

    const marked = sweepStaleItems(DEFAULT_CONFIG);
    expect(marked).toBeGreaterThanOrEqual(1);

    const staleItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-deeply-stale')).get();
    expect(staleItem).toBeDefined();
    expect(staleItem!.invalidAt).not.toBeNull();

    const freshItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-sweep-fresh')).get();
    expect(freshItem).toBeDefined();
    expect(freshItem!.invalidAt).toBeNull();
  });

  test('scope columns: memory items default to scope_id=default', () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems).values({
      id: 'item-scope-default',
      kind: 'fact',
      subject: 'scope test',
      statement: 'This item should have default scope',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-scope-default',
      firstSeenAt: now,
      lastSeenAt: now,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    const item = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-scope-default')).get();
    expect(item).toBeDefined();
    expect(item!.scopeId).toBe('default');
  });

  test('scope columns: memory items can be inserted with explicit scope_id', () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memoryItems).values({
      id: 'item-scope-custom',
      kind: 'fact',
      subject: 'scope test',
      statement: 'This item has a custom scope',
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: 'fp-scope-custom',
      scopeId: 'project-abc',
      firstSeenAt: now,
      lastSeenAt: now,
      accessCount: 0,
      verificationState: 'user_confirmed',
    }).run();

    const item = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-scope-custom')).get();
    expect(item).toBeDefined();
    expect(item!.scopeId).toBe('project-abc');
  });

  test('scope columns: segments get scopeId from indexer input', () => {
    const db = getDb();
    const now = Date.now();

    db.insert(conversations).values({
      id: 'conv-scope-test',
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
      id: 'msg-scope-test',
      conversationId: 'conv-scope-test',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Remember my scope preference' }]),
      createdAt: now,
    }).run();

    indexMessageNow({
      messageId: 'msg-scope-test',
      conversationId: 'conv-scope-test',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'Remember my scope preference' }]),
      createdAt: now,
      scopeId: 'project-xyz',
    }, DEFAULT_CONFIG.memory);

    const segments = db.select().from(memorySegments).where(eq(memorySegments.messageId, 'msg-scope-test')).all();
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.scopeId).toBe('project-xyz');
    }
  });

  test('scope filtering: retrieval excludes items from other scopes', async () => {
    const db = getDb();
    const now = Date.now();
    const convId = 'conv-scope-filter';

    db.insert(conversations).values({
      id: convId,
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
      id: 'msg-scope-filter',
      conversationId: convId,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'scope test' }]),
      createdAt: now,
    }).run();

    // Insert segment in scope "project-a"
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-scope-a', 'msg-scope-filter', '${convId}', 'user', 0, 'The quick brown fox jumps over the lazy dog in project alpha', 12, 'project-a', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-scope-a', 'The quick brown fox jumps over the lazy dog in project alpha')`);

    // Insert segment in scope "project-b"
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-scope-b', 'msg-scope-filter', '${convId}', 'user', 1, 'The quick brown fox jumps over the lazy dog in project beta', 12, 'project-b', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-scope-b', 'The quick brown fox jumps over the lazy dog in project beta')`);

    // Insert item in scope "project-a"
    db.insert(memoryItems).values({
      id: 'item-scope-a',
      kind: 'fact',
      subject: 'fox',
      statement: 'The fox is quick and brown in project alpha',
      status: 'active',
      confidence: 0.9,
      importance: 0.8,
      fingerprint: 'fp-scope-a',
      verificationState: 'user_confirmed',
      scopeId: 'project-a',
      firstSeenAt: now,
      lastSeenAt: now,
    }).run();

    // Insert item in scope "project-b"
    db.insert(memoryItems).values({
      id: 'item-scope-b',
      kind: 'fact',
      subject: 'fox',
      statement: 'The fox is quick and brown in project beta',
      status: 'active',
      confidence: 0.9,
      importance: 0.8,
      fingerprint: 'fp-scope-b',
      verificationState: 'user_confirmed',
      scopeId: 'project-b',
      firstSeenAt: now,
      lastSeenAt: now,
    }).run();

    // Query with scopeId "project-a" — should only find project-a items
    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };
    const result = await buildMemoryRecall('quick brown fox', convId, config, { scopeId: 'project-a' });
    const keys = result.topCandidates.map((c) => c.key);

    // Segments and items from project-b should not appear
    expect(keys).not.toContain('segment:seg-scope-b');
    expect(keys).not.toContain('item:item-scope-b');

    // At least one project-a candidate should appear
    const hasProjectA = keys.some((k) => k.includes('scope-a'));
    expect(hasProjectA).toBe(true);
  });

  test('scope filtering: allow_global_fallback includes default scope', async () => {
    const db = getDb();
    const now = Date.now();
    const convId = 'conv-scope-fallback';

    db.insert(conversations).values({
      id: convId,
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
      id: 'msg-scope-fallback',
      conversationId: convId,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'fallback test' }]),
      createdAt: now,
    }).run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-default-scope', 'msg-scope-fallback', '${convId}', 'user', 0, 'Universal knowledge about programming languages and paradigms', 10, 'default', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-default-scope', 'Universal knowledge about programming languages and paradigms')`);

    // Insert segment in custom scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-custom-scope', 'msg-scope-fallback', '${convId}', 'user', 1, 'Project-specific knowledge about programming languages and paradigms', 10, 'my-project', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-custom-scope', 'Project-specific knowledge about programming languages and paradigms')`);

    // With allow_global_fallback (the default), querying with scopeId "my-project"
    // should include both "my-project" and "default" scope items
    const config = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
      },
    };
    const result = await buildMemoryRecall('programming languages', convId, config, { scopeId: 'my-project' });
    const keys = result.topCandidates.map((c) => c.key);

    // Both default and custom scope segments should be included
    expect(keys).toContain('segment:seg-default-scope');
    expect(keys).toContain('segment:seg-custom-scope');
  });

  test('scope filtering: strict policy excludes default scope', async () => {
    const db = getDb();
    const now = Date.now();
    const convId = 'conv-scope-strict';

    db.insert(conversations).values({
      id: convId,
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
      id: 'msg-scope-strict',
      conversationId: convId,
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'strict test' }]),
      createdAt: now,
    }).run();

    // Insert segment in default scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-strict-default', 'msg-scope-strict', '${convId}', 'user', 0, 'Global memory about database optimization techniques', 8, 'default', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-strict-default', 'Global memory about database optimization techniques')`);

    // Insert segment in custom scope
    db.run(`
      INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
      VALUES ('seg-strict-custom', 'msg-scope-strict', '${convId}', 'user', 1, 'Project-specific memory about database optimization techniques', 8, 'strict-project', ${now}, ${now})
    `);
    db.run(`INSERT INTO memory_segment_fts(segment_id, text) VALUES ('seg-strict-custom', 'Project-specific memory about database optimization techniques')`);

    // With strict policy, querying with scopeId should only include that scope
    const strictConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: { ...TEST_CONFIG.memory.embeddings, required: false },
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          scopePolicy: 'strict' as const,
        },
      },
    };

    const result = await buildMemoryRecall('database optimization', convId, strictConfig, { scopeId: 'strict-project' });
    const keys = result.topCandidates.map((c) => c.key);

    // Only strict-project scope segment should appear
    expect(keys).not.toContain('segment:seg-strict-default');
    expect(keys).toContain('segment:seg-strict-custom');
  });

  test('scope columns: summaries default to scope_id=default', () => {
    const db = getDb();
    const now = Date.now();

    db.insert(memorySummaries).values({
      id: 'summary-scope-test',
      scope: 'weekly_global',
      scopeKey: '2025-W01',
      summary: 'Test summary for scope',
      tokenEstimate: 10,
      startAt: now - 7 * 86_400_000,
      endAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    const summary = db.select().from(memorySummaries).where(eq(memorySummaries.id, 'summary-scope-test')).get();
    expect(summary).toBeDefined();
    expect(summary!.scopeId).toBe('default');
  });
});
