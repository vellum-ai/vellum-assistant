import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'conflict-store-test-'));

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

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { memoryItems } from '../memory/schema.js';
import {
  applyConflictResolution,
  createOrUpdatePendingConflict,
  getConflictById,
  getPendingConflictByPair,
  listPendingConflictDetails,
  listPendingConflicts,
  markConflictAsked,
  resolveConflict,
} from '../memory/conflict-store.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM memory_item_conflicts');
  db.run('DELETE FROM memory_item_sources');
  db.run('DELETE FROM memory_items');
}

function insertItemPair(suffix: string, scopeId = 'default'): { existingItemId: string; candidateItemId: string } {
  const db = getDb();
  const now = Date.now();
  const existingItemId = `existing-${suffix}`;
  const candidateItemId = `candidate-${suffix}`;
  db.insert(memoryItems).values([
    {
      id: existingItemId,
      kind: 'fact',
      subject: 'framework preference',
      statement: `Existing statement ${suffix}`,
      status: 'active',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: `fp-existing-${suffix}`,
      verificationState: 'assistant_inferred',
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: candidateItemId,
      kind: 'fact',
      subject: 'framework preference',
      statement: `Candidate statement ${suffix}`,
      status: 'pending_clarification',
      confidence: 0.8,
      importance: 0.5,
      fingerprint: `fp-candidate-${suffix}`,
      verificationState: 'assistant_inferred',
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();

  return { existingItemId, candidateItemId };
}

describe('conflict-store', () => {
  beforeEach(() => {
    resetTables();
  });

  test('creates and fetches a pending conflict', () => {
    const pair = insertItemPair('create');
    const conflict = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
      clarificationQuestion: 'Do you prefer React or Vue?',
    });

    expect(conflict.id).toBeDefined();
    expect(conflict.status).toBe('pending_clarification');
    expect(conflict.scopeId).toBe('default');
    expect(conflict.relationship).toBe('ambiguous_contradiction');
    expect(conflict.clarificationQuestion).toBe('Do you prefer React or Vue?');

    const byPair = getPendingConflictByPair('default', pair.existingItemId, pair.candidateItemId);
    expect(byPair?.id).toBe(conflict.id);
  });

  test('deduplicates unresolved pair and updates fields in place', () => {
    const pair = insertItemPair('dedupe');
    const first = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'contradiction',
      clarificationQuestion: 'First question',
    });

    const second = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
      clarificationQuestion: 'Second question',
    });

    expect(second.id).toBe(first.id);
    expect(second.relationship).toBe('ambiguous_contradiction');
    expect(second.clarificationQuestion).toBe('Second question');
    expect(listPendingConflicts('default')).toHaveLength(1);
  });

  test('allows a new pending row for the same pair after resolution', () => {
    const pair = insertItemPair('reopen');
    const first = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });

    const resolved = resolveConflict(first.id, {
      status: 'resolved_keep_existing',
      resolutionNote: 'User confirmed existing statement is correct.',
    });
    expect(resolved?.status).toBe('resolved_keep_existing');
    expect(typeof resolved?.resolvedAt).toBe('number');

    const reopened = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
      clarificationQuestion: 'Please confirm again',
    });

    expect(reopened.id).not.toBe(first.id);
    expect(getConflictById(first.id)?.status).toBe('resolved_keep_existing');
    expect(listPendingConflicts('default')).toHaveLength(1);
  });

  test('lists only pending conflicts for a scope', () => {
    const defaultA = insertItemPair('scope-a');
    const defaultB = insertItemPair('scope-b');
    const otherScope = insertItemPair('scope-other', 'workspace-b');

    const conflictA = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: defaultA.existingItemId,
      candidateItemId: defaultA.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });
    const conflictB = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: defaultB.existingItemId,
      candidateItemId: defaultB.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });
    createOrUpdatePendingConflict({
      scopeId: 'workspace-b',
      existingItemId: otherScope.existingItemId,
      candidateItemId: otherScope.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });

    resolveConflict(conflictB.id, {
      status: 'dismissed',
      resolutionNote: 'Irrelevant to active context',
    });

    const pendingDefault = listPendingConflicts('default');
    expect(pendingDefault).toHaveLength(1);
    expect(pendingDefault[0].id).toBe(conflictA.id);
    expect(pendingDefault[0].status).toBe('pending_clarification');
  });

  test('markConflictAsked updates lastAskedAt', () => {
    const pair = insertItemPair('asked');
    const conflict = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });

    const askedAt = 1_734_000_000_000;
    expect(markConflictAsked(conflict.id, askedAt)).toBe(true);
    const updated = getConflictById(conflict.id);
    expect(updated?.lastAskedAt).toBe(askedAt);
    expect(updated?.updatedAt).toBe(askedAt);
  });

  test('listPendingConflictDetails joins current statements', () => {
    const pair = insertItemPair('details', 'workspace-a');
    createOrUpdatePendingConflict({
      scopeId: 'workspace-a',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
      clarificationQuestion: 'Which framework should I keep?',
    });

    const details = listPendingConflictDetails('workspace-a');
    expect(details).toHaveLength(1);
    expect(details[0].existingStatement).toBe('Existing statement details');
    expect(details[0].candidateStatement).toBe('Candidate statement details');
  });

  test('applyConflictResolution keeps candidate and resolves conflict row', () => {
    const pair = insertItemPair('apply-candidate');
    const conflict = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });

    expect(applyConflictResolution({
      conflictId: conflict.id,
      resolution: 'keep_candidate',
      resolutionNote: 'User confirmed candidate statement.',
    })).toBe(true);

    const db = getDb();
    const existing = db.select().from(memoryItems).where(eq(memoryItems.id, pair.existingItemId)).get();
    const candidate = db.select().from(memoryItems).where(eq(memoryItems.id, pair.candidateItemId)).get();
    const updatedConflict = getConflictById(conflict.id);

    expect(typeof existing?.invalidAt).toBe('number');
    expect(existing?.status).toBe('superseded');
    expect(candidate?.status).toBe('active');
    expect(updatedConflict?.status).toBe('resolved_keep_candidate');
  });

  test('applyConflictResolution merge updates existing item statement', () => {
    const pair = insertItemPair('apply-merge');
    const conflict = createOrUpdatePendingConflict({
      scopeId: 'default',
      existingItemId: pair.existingItemId,
      candidateItemId: pair.candidateItemId,
      relationship: 'ambiguous_contradiction',
    });

    const merged = 'Use React for dashboard pages and Vue for marketing pages.';
    expect(applyConflictResolution({
      conflictId: conflict.id,
      resolution: 'merge',
      mergedStatement: merged,
      resolutionNote: 'User clarified both apply in different contexts.',
    })).toBe(true);

    const db = getDb();
    const existing = db.select().from(memoryItems).where(eq(memoryItems.id, pair.existingItemId)).get();
    const candidate = db.select().from(memoryItems).where(eq(memoryItems.id, pair.candidateItemId)).get();
    const updatedConflict = getConflictById(conflict.id);

    expect(existing?.statement).toBe(merged);
    expect(candidate?.status).toBe('superseded');
    expect(updatedConflict?.status).toBe('resolved_merge');
  });

  test('enforces pending-pair uniqueness with a partial index', () => {
    const pair = insertItemPair('index');
    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const now = Date.now();

    raw.run(
      `INSERT INTO memory_item_conflicts (
        id, scope_id, existing_item_id, candidate_item_id, relationship, status,
        clarification_question, resolution_note, last_asked_at, resolved_at, created_at, updated_at
      ) VALUES (
        'conflict-index-a', 'default', '${pair.existingItemId}', '${pair.candidateItemId}',
        'ambiguous_contradiction', 'pending_clarification', NULL, NULL, NULL, NULL, ${now}, ${now}
      )`,
    );

    expect(() => {
      raw.run(
        `INSERT INTO memory_item_conflicts (
          id, scope_id, existing_item_id, candidate_item_id, relationship, status,
          clarification_question, resolution_note, last_asked_at, resolved_at, created_at, updated_at
        ) VALUES (
          'conflict-index-b', 'default', '${pair.existingItemId}', '${pair.candidateItemId}',
          'ambiguous_contradiction', 'pending_clarification', NULL, NULL, NULL, NULL, ${now + 1}, ${now + 1}
        )`,
      );
    }).toThrow();

    expect(() => {
      raw.run(
        `INSERT INTO memory_item_conflicts (
          id, scope_id, existing_item_id, candidate_item_id, relationship, status,
          clarification_question, resolution_note, last_asked_at, resolved_at, created_at, updated_at
        ) VALUES (
          'conflict-index-c', 'default', '${pair.existingItemId}', '${pair.candidateItemId}',
          'ambiguous_contradiction', 'resolved_keep_candidate', NULL, NULL, NULL, ${now + 2}, ${now + 2}, ${now + 2}
        )`,
      );
    }).not.toThrow();
  });
});
