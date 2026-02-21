import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'contradiction-checker-test-'));

let nextRelationship = 'ambiguous_contradiction';
let nextExplanation = 'Statements likely conflict but need confirmation.';
let classifyCallCount = 0;

const classifyRelationshipMock = mock(async () => {
  classifyCallCount += 1;
  return {
    content: [
      {
        type: 'tool_use',
        input: {
          relationship: nextRelationship,
          explanation: nextExplanation,
        },
      },
    ],
  };
});

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: classifyRelationshipMock,
    };
  },
}));

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

let mockConflictableKinds: string[] = [
  'preference', 'profile', 'project', 'decision', 'todo',
  'fact', 'constraint', 'relationship', 'event', 'opinion', 'instruction', 'style',
];

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: { anthropic: 'test-key' },
    memory: {
      conflicts: {
        conflictableKinds: mockConflictableKinds,
      },
    },
  }),
}));

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { checkContradictions } from '../memory/contradiction-checker.js';
import { memoryItemConflicts, memoryItems } from '../memory/schema.js';

beforeAll(() => {
  initializeDb();
});

beforeEach(() => {
  classifyCallCount = 0;
  mockConflictableKinds = [
    'preference', 'profile', 'project', 'decision', 'todo',
    'fact', 'constraint', 'relationship', 'event', 'opinion', 'instruction', 'style',
  ];
  const db = getDb();
  db.run('DELETE FROM memory_item_conflicts');
  db.run('DELETE FROM memory_item_sources');
  db.run('DELETE FROM memory_jobs');
  db.run('DELETE FROM memory_items');
});

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

function insertMemoryItem(params: {
  id: string;
  statement: string;
  scopeId?: string;
  status?: 'active' | 'pending_clarification';
  kind?: string;
}): void {
  const now = Date.now();
  const db = getDb();
  db.insert(memoryItems).values({
    id: params.id,
    kind: params.kind ?? 'preference',
    subject: 'framework preference',
    statement: params.statement,
    status: params.status ?? 'active',
    confidence: 0.8,
    importance: 0.7,
    fingerprint: `fp-${params.id}`,
    verificationState: 'assistant_inferred',
    scopeId: params.scopeId ?? 'default',
    firstSeenAt: now,
    lastSeenAt: now,
  }).run();
}

describe('checkContradictions', () => {
  test('marks candidate pending and writes one conflict row for ambiguous contradictions', async () => {
    nextRelationship = 'ambiguous_contradiction';
    nextExplanation = 'Seems contradictory; ask user to choose.';

    insertMemoryItem({
      id: 'item-existing-ambiguous',
      statement: 'User prefers React for frontend work.',
      scopeId: 'workspace-a',
    });
    insertMemoryItem({
      id: 'item-candidate-ambiguous',
      statement: 'User prefers Vue for frontend work.',
      scopeId: 'workspace-a',
    });

    await checkContradictions('item-candidate-ambiguous');

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, 'item-candidate-ambiguous'))
      .get();
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, 'item-existing-ambiguous'))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(1);
    expect(candidate?.status).toBe('pending_clarification');
    expect(existing?.invalidAt).toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status).toBe('pending_clarification');
    expect(conflicts[0].existingItemId).toBe('item-existing-ambiguous');
    expect(conflicts[0].candidateItemId).toBe('item-candidate-ambiguous');
    expect(conflicts[0].relationship).toBe('ambiguous_contradiction');
    expect(conflicts[0].clarificationQuestion).toContain('Which one is correct?');
  });

  test('keeps existing contradiction behavior and does not create conflict row', async () => {
    nextRelationship = 'contradiction';
    nextExplanation = 'The statements are directly incompatible.';

    insertMemoryItem({
      id: 'item-existing-contradiction',
      statement: 'User prefers dark mode.',
    });
    insertMemoryItem({
      id: 'item-candidate-contradiction',
      statement: 'User prefers light mode.',
    });

    await checkContradictions('item-candidate-contradiction');

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, 'item-candidate-contradiction'))
      .get();
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, 'item-existing-contradiction'))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(1);
    expect(candidate?.status).toBe('active');
    expect(typeof candidate?.validFrom).toBe('number');
    expect(typeof existing?.invalidAt).toBe('number');
    expect(conflicts).toHaveLength(0);
  });

  test('only evaluates contradiction candidates within the same scope', async () => {
    nextRelationship = 'ambiguous_contradiction';
    nextExplanation = 'Should not be used for this test.';

    insertMemoryItem({
      id: 'item-existing-other-scope',
      statement: 'Use Go for backend services.',
      scopeId: 'workspace-b',
    });
    insertMemoryItem({
      id: 'item-candidate-default-scope',
      statement: 'Use Rust for backend services.',
      scopeId: 'workspace-a',
    });

    await checkContradictions('item-candidate-default-scope');

    const db = getDb();
    const candidate = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, 'item-candidate-default-scope'))
      .get();
    const conflicts = db.select().from(memoryItemConflicts).all();

    expect(classifyCallCount).toBe(0);
    expect(candidate?.status).toBe('active');
    expect(conflicts).toHaveLength(0);
  });

  test('skips classification when item kind is not in conflictableKinds', async () => {
    mockConflictableKinds = ['instruction', 'style'];
    nextRelationship = 'ambiguous_contradiction';

    insertMemoryItem({
      id: 'item-existing-ineligible',
      statement: 'User prefers React for frontend work.',
    });
    insertMemoryItem({
      id: 'item-candidate-ineligible',
      statement: 'User prefers Vue for frontend work.',
    });

    await checkContradictions('item-candidate-ineligible');

    expect(classifyCallCount).toBe(0);
    const db = getDb();
    const conflicts = db.select().from(memoryItemConflicts).all();
    expect(conflicts).toHaveLength(0);
  });
});
