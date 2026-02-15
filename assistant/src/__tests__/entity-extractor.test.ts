import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'entity-extractor-test-'));

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
import { resolveEntityName, upsertEntity, upsertEntityRelation } from '../memory/entity-extractor.js';
import { memoryEntities, memoryEntityRelations } from '../memory/schema.js';

describe('entity extractor helpers', () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_entities');
    db.run('DELETE FROM memory_entity_relations');
    db.run('DELETE FROM memory_entities');
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

  test('upsertEntity reuses existing row via alias matching', () => {
    const db = getDb();

    const firstId = upsertEntity({
      name: 'VS Code',
      type: 'tool',
      aliases: ['vscode'],
    });
    const secondId = upsertEntity({
      name: 'Visual Studio Code',
      type: 'tool',
      aliases: ['VS Code', 'vscode'],
    });

    expect(secondId).toBe(firstId);
    expect(resolveEntityName('vscode')).toBe(firstId);
    expect(resolveEntityName('VS Code')).toBe(firstId);

    const stored = db
      .select()
      .from(memoryEntities)
      .where(eq(memoryEntities.id, firstId))
      .get();

    expect(stored).toBeDefined();
    expect(stored!.mentionCount).toBe(2);
    const aliases = stored!.aliases ? JSON.parse(stored!.aliases) as string[] : [];
    expect(aliases).toContain('vscode');
  });

  test('upsertEntityRelation merges duplicate edges by uniqueness key', () => {
    const db = getDb();
    const sourceEntityId = upsertEntity({
      name: 'Project Atlas',
      type: 'project',
      aliases: ['atlas'],
    });
    const targetEntityId = upsertEntity({
      name: 'Qdrant',
      type: 'tool',
      aliases: [],
    });

    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: 'uses',
      evidence: 'Project Atlas uses Qdrant for memory search',
      seenAt: 1_700_000_000_000,
    });
    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: 'uses',
      evidence: null,
      seenAt: 1_700_000_100_000,
    });
    upsertEntityRelation({
      sourceEntityId,
      targetEntityId,
      relation: 'uses',
      evidence: 'Atlas still depends on Qdrant',
      seenAt: 1_700_000_200_000,
    });

    const relationRows = db
      .select()
      .from(memoryEntityRelations)
      .where(and(
        eq(memoryEntityRelations.sourceEntityId, sourceEntityId),
        eq(memoryEntityRelations.targetEntityId, targetEntityId),
        eq(memoryEntityRelations.relation, 'uses'),
      ))
      .all();

    expect(relationRows.length).toBe(1);
    expect(relationRows[0].firstSeenAt).toBe(1_700_000_000_000);
    expect(relationRows[0].lastSeenAt).toBe(1_700_000_200_000);
    expect(relationRows[0].evidence).toBe('Atlas still depends on Qdrant');
  });

  test('upsertEntityRelation drops self-edges', () => {
    const db = getDb();
    const entityId = upsertEntity({
      name: 'Sidd',
      type: 'person',
      aliases: [],
    });

    upsertEntityRelation({
      sourceEntityId: entityId,
      targetEntityId: entityId,
      relation: 'collaborates_with',
      evidence: 'self edge should not be stored',
    });

    const relationRows = db.select().from(memoryEntityRelations).all();
    expect(relationRows.length).toBe(0);
  });
});
