import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'entity-search-test-'));

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

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { upsertEntity, upsertEntityRelation } from '../memory/entity-extractor.js';
import { findNeighborEntities, findMatchedEntities, getEntityLinkedItemCandidates } from '../memory/search/entity.js';
import { memoryItems, memoryItemEntities } from '../memory/schema.js';
import { Database } from 'bun:sqlite';

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function insertMemoryItem(id: string, opts?: { scopeId?: string; status?: string; invalidAt?: number | null }) {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryItems).values({
    id,
    kind: 'fact',
    subject: `Subject ${id}`,
    statement: `Statement for ${id}`,
    confidence: 0.9,
    importance: 0.5,
    status: opts?.status ?? 'active',
    invalidAt: opts?.invalidAt ?? null,
    scopeId: opts?.scopeId ?? 'default',
    fingerprint: `fp-${id}`,
    firstSeenAt: now,
    lastSeenAt: now,
    accessCount: 0,
    lastUsedAt: null,
    verificationState: 'assistant_inferred',
  }).run();
}

function linkItemToEntity(memoryItemId: string, entityId: string) {
  const db = getDb();
  db.insert(memoryItemEntities).values({ memoryItemId, entityId }).run();
}

function insertMemoryItemSource(memoryItemId: string, messageId: string) {
  // Bypass foreign key checks since we don't need actual message rows for these tests
  const raw = getRawDb();
  raw.run('PRAGMA foreign_keys = OFF');
  raw.run(
    `INSERT INTO memory_item_sources (memory_item_id, message_id, evidence, created_at)
     VALUES (?, ?, NULL, ?)`,
    [memoryItemId, messageId, Date.now()],
  );
  raw.run('PRAGMA foreign_keys = ON');
}

describe('entity search', () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_sources');
    db.run('DELETE FROM memory_item_entities');
    db.run('DELETE FROM memory_entity_relations');
    db.run('DELETE FROM memory_entities');
    db.run('DELETE FROM memory_items');
    db.run('DELETE FROM memory_checkpoints');
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  // ── findNeighborEntities ───────────────────────────────────────────

  describe('findNeighborEntities', () => {
    test('returns empty for empty seed list', () => {
      const result = findNeighborEntities([], { maxEdges: 10, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.neighborEntityIds).toEqual([]);
      expect(result.traversedEdgeCount).toBe(0);
    });

    test('returns empty when no edges exist', () => {
      const entityId = upsertEntity({ name: 'Lonely', type: 'concept', aliases: [] });
      const result = findNeighborEntities([entityId], { maxEdges: 10, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.neighborEntityIds).toEqual([]);
      expect(result.traversedEdgeCount).toBe(0);
    });

    test('single-hop: seed A has edge to B returns [B]', () => {
      const a = upsertEntity({ name: 'Alpha', type: 'project', aliases: [] });
      const b = upsertEntity({ name: 'Beta', type: 'tool', aliases: [] });

      upsertEntityRelation({
        sourceEntityId: a,
        targetEntityId: b,
        relation: 'uses',
        evidence: 'Alpha uses Beta',
      });

      const result = findNeighborEntities([a], { maxEdges: 10, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.neighborEntityIds).toContain(b);
      expect(result.neighborEntityIds).toHaveLength(1);
      expect(result.traversedEdgeCount).toBeGreaterThan(0);
    });

    test('multi-hop: A->B->C with maxDepth=2 returns [B, C]', () => {
      const a = upsertEntity({ name: 'NodeA', type: 'concept', aliases: [] });
      const b = upsertEntity({ name: 'NodeB', type: 'concept', aliases: [] });
      const c = upsertEntity({ name: 'NodeC', type: 'concept', aliases: [] });

      upsertEntityRelation({
        sourceEntityId: a,
        targetEntityId: b,
        relation: 'related_to',
        evidence: null,
      });
      upsertEntityRelation({
        sourceEntityId: b,
        targetEntityId: c,
        relation: 'related_to',
        evidence: null,
      });

      const result = findNeighborEntities([a], { maxEdges: 20, maxNeighborEntities: 10, maxDepth: 2 });
      expect(result.neighborEntityIds).toContain(b);
      expect(result.neighborEntityIds).toContain(c);
      expect(result.neighborEntityIds).toHaveLength(2);
    });

    test('cycle detection: A->B->A returns [B], does not loop', () => {
      const a = upsertEntity({ name: 'CycleA', type: 'person', aliases: [] });
      const b = upsertEntity({ name: 'CycleB', type: 'person', aliases: [] });

      upsertEntityRelation({
        sourceEntityId: a,
        targetEntityId: b,
        relation: 'collaborates_with',
        evidence: null,
      });
      upsertEntityRelation({
        sourceEntityId: b,
        targetEntityId: a,
        relation: 'collaborates_with',
        evidence: null,
      });

      const result = findNeighborEntities([a], { maxEdges: 20, maxNeighborEntities: 10, maxDepth: 5 });
      expect(result.neighborEntityIds).toEqual([b]);
    });

    test('maxDepth=1 stops after first hop', () => {
      const a = upsertEntity({ name: 'DepthA', type: 'concept', aliases: [] });
      const b = upsertEntity({ name: 'DepthB', type: 'concept', aliases: [] });
      const c = upsertEntity({ name: 'DepthC', type: 'concept', aliases: [] });

      upsertEntityRelation({
        sourceEntityId: a,
        targetEntityId: b,
        relation: 'depends_on',
        evidence: null,
      });
      upsertEntityRelation({
        sourceEntityId: b,
        targetEntityId: c,
        relation: 'depends_on',
        evidence: null,
      });

      const result = findNeighborEntities([a], { maxEdges: 20, maxNeighborEntities: 10, maxDepth: 1 });
      expect(result.neighborEntityIds).toContain(b);
      expect(result.neighborEntityIds).not.toContain(c);
      expect(result.neighborEntityIds).toHaveLength(1);
    });

    test('maxEdges budget exhaustion stops traversal', () => {
      const a = upsertEntity({ name: 'BudgetA', type: 'concept', aliases: [] });
      const b = upsertEntity({ name: 'BudgetB', type: 'concept', aliases: [] });
      const c = upsertEntity({ name: 'BudgetC', type: 'concept', aliases: [] });
      const d = upsertEntity({ name: 'BudgetD', type: 'concept', aliases: [] });

      upsertEntityRelation({ sourceEntityId: a, targetEntityId: b, relation: 'related_to', evidence: null });
      upsertEntityRelation({ sourceEntityId: a, targetEntityId: c, relation: 'related_to', evidence: null });
      upsertEntityRelation({ sourceEntityId: b, targetEntityId: d, relation: 'related_to', evidence: null });

      // Allow only 1 edge total, so BFS can't explore much
      const result = findNeighborEntities([a], { maxEdges: 1, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.traversedEdgeCount).toBeLessThanOrEqual(1);
    });

    test('maxNeighborEntities cap limits result size', () => {
      const seed = upsertEntity({ name: 'HubNode', type: 'concept', aliases: [] });
      const neighbors: string[] = [];
      for (let i = 0; i < 5; i++) {
        const n = upsertEntity({ name: `Spoke${i}`, type: 'concept', aliases: [] });
        neighbors.push(n);
        upsertEntityRelation({ sourceEntityId: seed, targetEntityId: n, relation: 'related_to', evidence: null });
      }

      const result = findNeighborEntities([seed], { maxEdges: 20, maxNeighborEntities: 2, maxDepth: 3 });
      expect(result.neighborEntityIds).toHaveLength(2);
    });

    test('bidirectional: edge from X->A discovers X from seed [A]', () => {
      const a = upsertEntity({ name: 'TargetNode', type: 'tool', aliases: [] });
      const x = upsertEntity({ name: 'SourceNode', type: 'tool', aliases: [] });

      upsertEntityRelation({
        sourceEntityId: x,
        targetEntityId: a,
        relation: 'uses',
        evidence: null,
      });

      const result = findNeighborEntities([a], { maxEdges: 10, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.neighborEntityIds).toContain(x);
    });

    test('multiple seeds: [A, B] discovers neighbors of both', () => {
      const a = upsertEntity({ name: 'SeedA', type: 'project', aliases: [] });
      const b = upsertEntity({ name: 'SeedB', type: 'project', aliases: [] });
      const na = upsertEntity({ name: 'NeighborOfA', type: 'tool', aliases: [] });
      const nb = upsertEntity({ name: 'NeighborOfB', type: 'tool', aliases: [] });

      upsertEntityRelation({ sourceEntityId: a, targetEntityId: na, relation: 'uses', evidence: null });
      upsertEntityRelation({ sourceEntityId: b, targetEntityId: nb, relation: 'uses', evidence: null });

      const result = findNeighborEntities([a, b], { maxEdges: 20, maxNeighborEntities: 10, maxDepth: 3 });
      expect(result.neighborEntityIds).toContain(na);
      expect(result.neighborEntityIds).toContain(nb);
    });

    test('relationTypes filter: only follows specified edge types', () => {
      const idA = upsertEntity({ name: 'PersonAlpha', type: 'person', aliases: [] });
      const idB = upsertEntity({ name: 'ToolBeta', type: 'tool', aliases: [] });
      const idC = upsertEntity({ name: 'ProjectGamma', type: 'project', aliases: [] });

      upsertEntityRelation({ sourceEntityId: idA, targetEntityId: idB, relation: 'uses' });
      upsertEntityRelation({ sourceEntityId: idA, targetEntityId: idC, relation: 'works_on' });

      const result = findNeighborEntities([idA], {
        maxEdges: 10,
        maxNeighborEntities: 10,
        maxDepth: 1,
        relationTypes: ['uses'],
      });

      expect(result.neighborEntityIds).toContain(idB);
      expect(result.neighborEntityIds).not.toContain(idC);
    });

    test('relationTypes filter: omitting filter follows all edge types', () => {
      const idA = upsertEntity({ name: 'PersonDelta', type: 'person', aliases: [] });
      const idB = upsertEntity({ name: 'ToolEpsilon', type: 'tool', aliases: [] });
      const idC = upsertEntity({ name: 'ProjectZeta', type: 'project', aliases: [] });

      upsertEntityRelation({ sourceEntityId: idA, targetEntityId: idB, relation: 'uses' });
      upsertEntityRelation({ sourceEntityId: idA, targetEntityId: idC, relation: 'works_on' });

      const result = findNeighborEntities([idA], {
        maxEdges: 10,
        maxNeighborEntities: 10,
        maxDepth: 1,
      });

      expect(result.neighborEntityIds).toContain(idB);
      expect(result.neighborEntityIds).toContain(idC);
    });
  });

  // ── findMatchedEntities ────────────────────────────────────────────

  describe('findMatchedEntities', () => {
    test('exact canonical name match', () => {
      const entityId = upsertEntity({ name: 'Qdrant', type: 'tool', aliases: [] });
      const results = findMatchedEntities('Qdrant', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === entityId)).toBe(true);
    });

    test('alias match', () => {
      const entityId = upsertEntity({ name: 'Visual Studio Code', type: 'tool', aliases: ['vscode', 'VS Code'] });
      const results = findMatchedEntities('vscode', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === entityId)).toBe(true);
    });

    test('multi-word entity name match (full query)', () => {
      const entityId = upsertEntity({ name: 'Visual Studio Code', type: 'tool', aliases: [] });
      const results = findMatchedEntities('Visual Studio Code', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === entityId)).toBe(true);
    });

    test('tokens < 3 chars are ignored but full query still matches', () => {
      // "VS" has only 2 chars, so it is filtered as a token.
      // But the full query "VS" is still matched against entity names and aliases.
      const entityId = upsertEntity({ name: 'VS', type: 'tool', aliases: [] });
      const results = findMatchedEntities('VS', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.id === entityId)).toBe(true);
    });

    test('returns empty for no matches', () => {
      upsertEntity({ name: 'Existing', type: 'concept', aliases: [] });
      const results = findMatchedEntities('NonExistentEntity', 10);
      expect(results).toEqual([]);
    });

    test('respects maxMatches limit', () => {
      // Insert entities directly via raw DB to avoid upsertEntity dedup logic.
      // All share the alias "gadget" so they all match the same query.
      const raw = getRawDb();
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const id = crypto.randomUUID();
        raw.run(
          `INSERT INTO memory_entities (id, name, type, aliases, description, first_seen_at, last_seen_at, mention_count)
           VALUES (?, ?, 'concept', '["gadget"]', NULL, ?, ?, 1)`,
          [id, `Gadget${i}`, now, now],
        );
      }

      const results = findMatchedEntities('gadget', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // ── getEntityLinkedItemCandidates ──────────────────────────────────

  describe('getEntityLinkedItemCandidates', () => {
    test('returns items linked to given entity IDs', () => {
      const entityId = upsertEntity({ name: 'LinkedEntity', type: 'project', aliases: [] });
      insertMemoryItem('item-linked-1');
      linkItemToEntity('item-linked-1', entityId);

      const candidates = getEntityLinkedItemCandidates([entityId], {
        source: 'entity_direct',
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe('item-linked-1');
      expect(candidates[0].source).toBe('entity_direct');
      expect(candidates[0].type).toBe('item');
    });

    test('excludes items from excluded message IDs', () => {
      const entityId = upsertEntity({ name: 'ExcludeEntity', type: 'tool', aliases: [] });

      insertMemoryItem('item-excl-1');
      linkItemToEntity('item-excl-1', entityId);
      // Source the item from a message we will exclude
      insertMemoryItemSource('item-excl-1', 'msg-to-exclude');

      insertMemoryItem('item-excl-2');
      linkItemToEntity('item-excl-2', entityId);
      // Source from a non-excluded message
      insertMemoryItemSource('item-excl-2', 'msg-ok');

      const candidates = getEntityLinkedItemCandidates([entityId], {
        source: 'entity_direct',
        excludedMessageIds: ['msg-to-exclude'],
      });

      expect(candidates.some((c) => c.id === 'item-excl-1')).toBe(false);
      expect(candidates.some((c) => c.id === 'item-excl-2')).toBe(true);
    });

    test('returns empty for entity IDs with no linked items', () => {
      const entityId = upsertEntity({ name: 'NoItems', type: 'concept', aliases: [] });

      const candidates = getEntityLinkedItemCandidates([entityId], {
        source: 'entity_direct',
      });

      expect(candidates).toEqual([]);
    });
  });
});
