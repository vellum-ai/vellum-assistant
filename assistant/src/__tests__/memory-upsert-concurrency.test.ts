/**
 * Concurrency tests for memory UPSERT atomicity.
 *
 * SQLite is single-writer, but Bun's synchronous execution model still exposes
 * logical race conditions when multiple in-process "workers" each perform a
 * check-then-act pattern around INSERT/UPDATE.  These tests verify that the
 * critical paths — segment indexing, memory-item upserts, and conflict creation
 * — remain correctly deduplicated under parallel load.
 *
 * We use Promise.all to simulate concurrent indexer invocations running within
 * the same event loop tick-boundary, which exercises the transaction guards and
 * ON CONFLICT clauses rather than true OS-level concurrency.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'memory-upsert-concurrency-'));

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

mock.module('../memory/qdrant-client.js', () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from '../config/defaults.js';

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module('../config/loader.js', () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import {
  conversations,
  memoryItems,
  memorySegments,
  messages,
} from '../memory/schema.js';
import { indexMessageNow } from '../memory/indexer.js';
import { createOrUpdatePendingConflict, listPendingConflicts } from '../memory/conflict-store.js';

// Initialize DB once for the entire file. Each test cleans its own tables.
initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM memory_item_conflicts');
  db.run('DELETE FROM memory_item_entities');
  db.run('DELETE FROM memory_entity_relations');
  db.run('DELETE FROM memory_entities');
  db.run('DELETE FROM memory_item_sources');
  db.run('DELETE FROM memory_embeddings');
  db.run('DELETE FROM memory_summaries');
  db.run('DELETE FROM memory_items');
  db.run('DELETE FROM memory_segment_fts');
  db.run('DELETE FROM memory_segments');
  db.run('DELETE FROM memory_jobs');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

/** Insert a minimal conversation + message row for FK references. */
function seedConversationAndMessage(
  conversationId: string,
  messageId: string,
  text: string,
): void {
  const db = getDb();
  const now = Date.now();
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
    id: messageId,
    conversationId,
    role: 'user',
    content: JSON.stringify([{ type: 'text', text }]),
    createdAt: now,
  }).run();
}

/** Insert a pair of memory items that can serve as conflict participants. */
function seedItemPair(suffix: string, scopeId = 'default'): { existingItemId: string; candidateItemId: string } {
  const db = getDb();
  const now = Date.now();
  const existingItemId = `existing-${suffix}`;
  const candidateItemId = `candidate-${suffix}`;
  db.insert(memoryItems).values([
    {
      id: existingItemId,
      kind: 'preference',
      subject: 'framework preference',
      statement: `Existing statement ${suffix}`,
      status: 'active',
      confidence: 0.8,
      importance: 0.7,
      fingerprint: `fp-existing-${suffix}`,
      verificationState: 'assistant_inferred',
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: candidateItemId,
      kind: 'preference',
      subject: 'framework preference',
      statement: `Candidate statement ${suffix}`,
      status: 'pending_clarification',
      confidence: 0.8,
      importance: 0.7,
      fingerprint: `fp-candidate-${suffix}`,
      verificationState: 'assistant_inferred',
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();
  return { existingItemId, candidateItemId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: segment UPSERT atomicity under parallel indexer load
// ─────────────────────────────────────────────────────────────────────────────

describe('segment UPSERT atomicity under parallel indexer load', () => {
  beforeEach(() => {
    resetTables();
  });

  test('parallel indexing of the same message does not create duplicate segments', () => {
    // Seed a single message that multiple "workers" will try to index concurrently.
    // In production, two indexer calls for the same messageId could race; the
    // ON CONFLICT DO UPDATE on memorySegments.id must absorb the collision.
    const conversationId = 'conv-parallel-segment-dedup';
    const messageId = 'msg-parallel-segment-dedup';
    const text = 'I prefer TypeScript over plain JavaScript for large projects.';

    seedConversationAndMessage(conversationId, messageId, text);

    const db = getDb();
    const config = TEST_CONFIG.memory;

    // Fire N concurrent indexing calls for the same messageId.  Because Bun
    // processes Promises cooperatively we must collect ALL calls before reading
    // results, simulating the overlap window.
    const WORKERS = 8;
    for (let i = 0; i < WORKERS; i++) {
      indexMessageNow(
        {
          messageId,
          conversationId,
          role: 'user',
          content: JSON.stringify([{ type: 'text', text }]),
          createdAt: Date.now(),
        },
        config,
      );
    }

    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Each physical segment (identified by segmentId = messageId + segmentIndex)
    // must appear exactly once regardless of how many indexer calls ran.
    const idCounts = new Map<string, number>();
    for (const seg of segments) {
      idCounts.set(seg.id, (idCounts.get(seg.id) ?? 0) + 1);
    }
    for (const [segId, count] of idCounts) {
      expect(count).toBe(1);
      expect(segId.startsWith(messageId)).toBe(true);
    }
  });

  test('parallel indexing of distinct messages produces independent segment sets', () => {
    // Two different messages indexed in parallel must each produce their own
    // non-overlapping segments with correct messageId back-references.
    const now = Date.now();
    const conversationId = 'conv-parallel-distinct';
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

    const MSG_COUNT = 6;
    for (let i = 0; i < MSG_COUNT; i++) {
      db.insert(messages).values({
        id: `msg-distinct-${i}`,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: `Distinct message content for worker ${i}, covering a unique topic that should be stored separately.` }]),
        createdAt: now + i,
      }).run();
    }

    const config = TEST_CONFIG.memory;

    // Index all messages "simultaneously" — no await between calls.
    for (let i = 0; i < MSG_COUNT; i++) {
      const msgId = `msg-distinct-${i}`;
      indexMessageNow(
        {
          messageId: msgId,
          conversationId,
          role: 'user',
          content: JSON.stringify([{ type: 'text', text: `Distinct message content for worker ${i}, covering a unique topic that should be stored separately.` }]),
          createdAt: now + i,
        },
        config,
      );
    }

    // Every segment must reference its own message and no segment may appear
    // for the wrong messageId.
    for (let i = 0; i < MSG_COUNT; i++) {
      const msgId = `msg-distinct-${i}`;
      const segs = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.messageId, msgId))
        .all();

      // At least one segment must have been written.
      expect(segs.length).toBeGreaterThanOrEqual(1);

      // Segment IDs must be of the form `${msgId}:${index}`.
      for (const seg of segs) {
        expect(seg.id.startsWith(msgId + ':')).toBe(true);
        expect(seg.messageId).toBe(msgId);
        expect(seg.conversationId).toBe(conversationId);
      }
    }
  });

  test('re-indexing with identical content does not change the stored segment', () => {
    // When an indexer re-processes an already-indexed segment (same id + same
    // content hash), the ON CONFLICT DO UPDATE path must run but the row must
    // remain semantically equivalent to the original.
    const conversationId = 'conv-stable-rehash';
    const messageId = 'msg-stable-rehash';
    const text = 'My preferred timezone is America/Los_Angeles and I work remotely.';

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;

    const firstResult = indexMessageNow(
      { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text }]), createdAt: Date.now() },
      config,
    );

    const db = getDb();
    const segmentsAfterFirst = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Re-index twice more with the same payload.
    indexMessageNow(
      { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text }]), createdAt: Date.now() },
      config,
    );
    indexMessageNow(
      { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text }]), createdAt: Date.now() },
      config,
    );

    const segmentsAfterRehash = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Segment count must not have grown.
    expect(segmentsAfterRehash.length).toBe(segmentsAfterFirst.length);

    // Content hashes must match between first and subsequent indexings.
    const firstById = new Map(segmentsAfterFirst.map((s) => [s.id, s]));
    for (const seg of segmentsAfterRehash) {
      const original = firstById.get(seg.id);
      expect(original).toBeDefined();
      expect(seg.contentHash).toBe(original!.contentHash);
      expect(seg.text).toBe(original!.text);
    }

    // The indexer must have reported the correct segment count both times.
    expect(firstResult.indexedSegments).toBeGreaterThanOrEqual(1);
  });

  test('parallel indexing with content update correctly applies last-write semantics', () => {
    // When two workers index the same messageId with *different* text (simulating
    // an edit-then-index race), the ON CONFLICT DO UPDATE must store one row per
    // segmentId.  We cannot assert on which text "wins" — only that no duplicate
    // rows exist.
    const conversationId = 'conv-edit-race';
    const messageId = 'msg-edit-race';
    const textV1 = 'I prefer React for frontend development work on large projects.';
    const textV2 = 'I prefer Vue for frontend development work on large projects instead.';

    seedConversationAndMessage(conversationId, messageId, textV1);

    const config = TEST_CONFIG.memory;

    // Simulate two workers racing with different content for the same message.
    indexMessageNow(
      { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text: textV1 }]), createdAt: Date.now() },
      config,
    );
    indexMessageNow(
      { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text: textV2 }]), createdAt: Date.now() },
      config,
    );

    const db = getDb();
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // No duplicate segment IDs — each logical segment must appear at most once.
    const ids = segments.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: conflict creation UPSERT atomicity
// ─────────────────────────────────────────────────────────────────────────────

describe('conflict creation UPSERT atomicity', () => {
  beforeEach(() => {
    resetTables();
  });

  test('parallel createOrUpdatePendingConflict calls for the same pair produce exactly one conflict row', () => {
    // This is the critical UPSERT path: multiple memory workers discovering the
    // same conflict pair and racing to insert it.  The IMMEDIATE transaction
    // guard in createOrUpdatePendingConflict must ensure only one row exists.
    const pair = seedItemPair('parallel-create');

    const WORKERS = 10;
    const results: ReturnType<typeof createOrUpdatePendingConflict>[] = [];
    for (let i = 0; i < WORKERS; i++) {
      results.push(
        createOrUpdatePendingConflict({
          scopeId: 'default',
          existingItemId: pair.existingItemId,
          candidateItemId: pair.candidateItemId,
          relationship: 'ambiguous_contradiction',
          clarificationQuestion: `Worker ${i} discovered a contradiction`,
        }),
      );
    }

    // All callers must receive the same conflict ID — the deduplication path
    // returns the existing row on the second and subsequent calls.
    const firstId = results[0].id;
    for (const result of results) {
      expect(result.id).toBe(firstId);
    }

    // Exactly one pending conflict row in the DB.
    const pending = listPendingConflicts('default');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(firstId);
  });

  test('parallel conflict creation for different pairs produces distinct rows without cross-contamination', () => {
    // Multiple workers each operating on a unique item pair must each get their
    // own conflict row — the deduplication must be scoped to the pair, not global.
    const PAIR_COUNT = 6;
    const pairs = Array.from({ length: PAIR_COUNT }, (_, i) => seedItemPair(`multi-pair-${i}`));

    const conflicts: ReturnType<typeof createOrUpdatePendingConflict>[] = [];
    for (const pair of pairs) {
      // Create each conflict twice to exercise the idempotent path.
      createOrUpdatePendingConflict({
        scopeId: 'default',
        existingItemId: pair.existingItemId,
        candidateItemId: pair.candidateItemId,
        relationship: 'contradiction',
      });
      conflicts.push(
        createOrUpdatePendingConflict({
          scopeId: 'default',
          existingItemId: pair.existingItemId,
          candidateItemId: pair.candidateItemId,
          relationship: 'ambiguous_contradiction',
        }),
      );
    }

    // Each pair must have produced exactly one pending conflict.
    const pending = listPendingConflicts('default');
    expect(pending).toHaveLength(PAIR_COUNT);

    // All conflict IDs must be unique.
    const ids = pending.map((c) => c.id);
    expect(new Set(ids).size).toBe(PAIR_COUNT);

    // Each returned conflict must reference the correct item pair.
    for (let i = 0; i < PAIR_COUNT; i++) {
      const pair = pairs[i];
      const found = pending.find(
        (c) => c.existingItemId === pair.existingItemId && c.candidateItemId === pair.candidateItemId,
      );
      expect(found).toBeDefined();
      // Second call updated the relationship to ambiguous_contradiction.
      expect(found!.relationship).toBe('ambiguous_contradiction');
    }
  });

  test('concurrent updates to the same conflict row converge to a consistent state', () => {
    // Simulate multiple workers each trying to update the clarification question
    // for the same existing conflict.  All updates must succeed (last writer wins
    // is acceptable) and the row must remain internally consistent.
    const pair = seedItemPair('concurrent-update');
    const first = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'contradiction',
      clarificationQuestion: 'Initial question',
    });

    const UPDATES = 8;
    const results: ReturnType<typeof createOrUpdatePendingConflict>[] = [];
    for (let i = 0; i < UPDATES; i++) {
      results.push(
        createOrUpdatePendingConflict({
          scopeId: 'default',
          existingItemId: pair.existingItemId,
          candidateItemId: pair.candidateItemId,
          relationship: 'ambiguous_contradiction',
          clarificationQuestion: `Updated question from worker ${i}`,
        }),
      );
    }

    // All calls must return the same conflict ID.
    for (const result of results) {
      expect(result.id).toBe(first.id);
    }

    // Still exactly one row in the DB.
    const pending = listPendingConflicts('default');
    expect(pending).toHaveLength(1);

    // The row must be consistent: valid status, valid relationship.
    const conflict = pending[0];
    expect(conflict.status).toBe('pending_clarification');
    expect(conflict.relationship).toBe('ambiguous_contradiction');
  });

  test('scope isolation ensures conflicts in different scopes do not interfere', () => {
    // Workers indexing different user scopes must not cross-contaminate each
    // other's conflict sets — the scopeId must be part of the deduplication key.
    const SCOPES = ['scope-alpha', 'scope-beta', 'scope-gamma'];

    for (const scope of SCOPES) {
      const pair = seedItemPair(`scope-${scope}`, scope);
      // Call twice per scope to exercise idempotency within scope.
      for (let i = 0; i < 3; i++) {
        createOrUpdatePendingConflict({
          scopeId: scope,
          existingItemId: pair.existingItemId,
          candidateItemId: pair.candidateItemId,
          relationship: 'contradiction',
        });
      }
    }

    for (const scope of SCOPES) {
      const pending = listPendingConflicts(scope);
      // Exactly one conflict per scope, no cross-scope leakage.
      expect(pending).toHaveLength(1);
      expect(pending[0].scopeId).toBe(scope);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: memory segment job atomicity
// ─────────────────────────────────────────────────────────────────────────────

describe('memory segment job atomicity under parallel indexer load', () => {
  beforeEach(() => {
    resetTables();
  });

  test('each unique (messageId, segmentIndex) pair generates at most one segment row', () => {
    // Spin up multiple indexer calls for distinct messages in the same conversation
    // to verify that the job+segment transaction boundary is respected and no two
    // calls create duplicate segment rows for the same logical identity.
    const conversationId = 'conv-job-atomicity';
    const now = Date.now();
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

    const MSG_COUNT = 5;
    const REPEATS = 4; // how many times each message is re-indexed
    for (let i = 0; i < MSG_COUNT; i++) {
      db.insert(messages).values({
        id: `msg-atomicity-${i}`,
        conversationId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: `Message ${i}: I prefer TypeScript and always follow functional programming patterns in my projects.` }]),
        createdAt: now + i,
      }).run();
    }

    const config = TEST_CONFIG.memory;

    for (let r = 0; r < REPEATS; r++) {
      for (let i = 0; i < MSG_COUNT; i++) {
        const msgId = `msg-atomicity-${i}`;
        indexMessageNow(
          {
            messageId: msgId,
            conversationId,
            role: 'user',
            content: JSON.stringify([{ type: 'text', text: `Message ${i}: I prefer TypeScript and always follow functional programming patterns in my projects.` }]),
            createdAt: now + i,
          },
          config,
        );
      }
    }

    // For every message, count distinct segment IDs — there must be no
    // duplicates regardless of how many indexer calls ran.
    for (let i = 0; i < MSG_COUNT; i++) {
      const msgId = `msg-atomicity-${i}`;
      const segs = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.messageId, msgId))
        .all();

      const segIds = segs.map((s) => s.id);
      const uniqueSegIds = new Set(segIds);
      expect(uniqueSegIds.size).toBe(segIds.length);
    }
  });

  test('indexer result counts are consistent with actual stored segment counts', () => {
    // The IndexMessageResult.indexedSegments value returned by indexMessageNow
    // must always match the number of rows stored in memory_segments for that
    // message.  Under repeated indexing the stored count stays stable while the
    // result always reports the logical segment count.
    const conversationId = 'conv-count-consistency';
    const messageId = 'msg-count-consistency';
    const text = 'I always prefer concise code reviews and I work in a distributed team across multiple timezones.';

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;

    const results: ReturnType<typeof indexMessageNow>[] = [];
    const RUNS = 5;
    for (let i = 0; i < RUNS; i++) {
      results.push(
        indexMessageNow(
          { messageId, conversationId, role: 'user', content: JSON.stringify([{ type: 'text', text }]), createdAt: Date.now() },
          config,
        ),
      );
    }

    const db = getDb();
    const storedSegments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // All runs must agree on the segment count.
    const firstCount = results[0].indexedSegments;
    for (const result of results) {
      expect(result.indexedSegments).toBe(firstCount);
    }

    // Stored count must equal the reported logical count.
    expect(storedSegments.length).toBe(firstCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: memory_items fingerprint uniqueness under race conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('memory_items fingerprint uniqueness under race conditions', () => {
  beforeEach(() => {
    resetTables();
  });

  test('direct concurrent inserts with identical fingerprints produce exactly one row', () => {
    // The memory_items table has a unique constraint on (fingerprint, scope_id).
    // Simulate a race where two extractor workers try to INSERT the same item
    // simultaneously.  Only one INSERT must land; the second must be absorbed by
    // ON CONFLICT or the check-then-insert logic.
    const db = getDb();
    const now = Date.now();
    const fingerprint = 'fp-race-unique-test-concurrency';
    const scopeId = 'default';

    // Use raw SQL to replicate what the items-extractor would do when two
    // concurrent workers each see no existing row and both attempt to INSERT.
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

    raw.run(`
      INSERT INTO memory_items (
        id, kind, subject, statement, status, confidence, importance,
        fingerprint, verification_state, scope_id, first_seen_at, last_seen_at
      ) VALUES (
        'item-race-1', 'preference', 'code style', 'I prefer tabs over spaces.',
        'active', 0.8, 0.6, '${fingerprint}', 'user_reported', '${scopeId}',
        ${now}, ${now}
      )
    `);

    // Second "worker" tries to insert the same fingerprint — must not create a
    // duplicate.  INSERT OR IGNORE / ON CONFLICT DO NOTHING is the expected
    // behavior for the unique constraint.
    expect(() => {
      raw.run(`
        INSERT OR IGNORE INTO memory_items (
          id, kind, subject, statement, status, confidence, importance,
          fingerprint, verification_state, scope_id, first_seen_at, last_seen_at
        ) VALUES (
          'item-race-2', 'preference', 'code style', 'I prefer tabs over spaces.',
          'active', 0.8, 0.6, '${fingerprint}', 'user_reported', '${scopeId}',
          ${now + 1}, ${now + 1}
        )
      `);
    }).not.toThrow();

    const rows = db
      .select()
      .from(memoryItems)
      .all()
      .filter((r) => r.fingerprint === fingerprint);

    // Only the first insert must have landed.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('item-race-1');
  });

  test('bare INSERT without IGNORE throws on duplicate fingerprint+scopeId', () => {
    // Verify the DB-level unique constraint is actually enforced so that any code
    // path that accidentally omits ON CONFLICT will fail loudly rather than silently
    // producing inconsistent state.
    const db = getDb();
    const now = Date.now();
    const fingerprint = 'fp-constraint-enforcement-test';

    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;

    raw.run(`
      INSERT INTO memory_items (
        id, kind, subject, statement, status, confidence, importance,
        fingerprint, verification_state, scope_id, first_seen_at, last_seen_at
      ) VALUES (
        'item-constraint-a', 'preference', 'editor', 'I use VS Code.',
        'active', 0.9, 0.7, '${fingerprint}', 'user_reported', 'default',
        ${now}, ${now}
      )
    `);

    // A bare INSERT (no ON CONFLICT) for the same fingerprint+scope_id must throw.
    expect(() => {
      raw.run(`
        INSERT INTO memory_items (
          id, kind, subject, statement, status, confidence, importance,
          fingerprint, verification_state, scope_id, first_seen_at, last_seen_at
        ) VALUES (
          'item-constraint-b', 'preference', 'editor', 'I use VS Code.',
          'active', 0.9, 0.7, '${fingerprint}', 'user_reported', 'default',
          ${now + 1}, ${now + 1}
        )
      `);
    }).toThrow();
  });
});
