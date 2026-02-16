import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ensureDataDir,
  migrateToDataLayout,
  migrateToWorkspaceLayout,
} from '../util/platform.js';
import { invalidateConfigCache } from '../config/loader.js';

const originalBaseDataDir = process.env.BASE_DATA_DIR;

function makeTmpBase(): string {
  const base = join(
    tmpdir(),
    `migration-order-test-${randomBytes(4).toString('hex')}`,
  );
  mkdirSync(base, { recursive: true });
  return base;
}

afterEach(() => {
  if (originalBaseDataDir == null) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = originalBaseDataDir;
  }
  invalidateConfigCache();
});

/**
 * Populate a fake ~/.vellum directory with legacy items that
 * migrateToWorkspaceLayout() should relocate into workspace/.
 */
function populateLegacyLayout(root: string): void {
  mkdirSync(root, { recursive: true });

  // config.json at root
  writeFileSync(join(root, 'config.json'), '{"theme":"dark"}');

  // data dir with db and logs
  mkdirSync(join(root, 'data', 'db'), { recursive: true });
  writeFileSync(join(root, 'data', 'db', 'assistant.db'), 'db-content');
  mkdirSync(join(root, 'data', 'logs'), { recursive: true });
  writeFileSync(join(root, 'data', 'logs', 'vellum.log'), 'log-content');

  // hooks
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'on-start.sh'), '#!/bin/bash');

  // prompt files
  writeFileSync(join(root, 'IDENTITY.md'), '# Identity');
  writeFileSync(join(root, 'SOUL.md'), '# Soul');
  writeFileSync(join(root, 'USER.md'), '# User');

  // skills
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'search.json'), '{}');
}

describe('migration ordering: ensureDataDir before migration', () => {
  test('ensureDataDir() before migrateToWorkspaceLayout() prevents directory migration', () => {
    // This is the critical regression test. Before the fix, calling
    // ensureDataDir() first would pre-create workspace/data, workspace/hooks,
    // workspace/skills — causing migrateToWorkspaceLayout() to skip those
    // moves because the destination already existed.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    // Simulate the old bug: call ensureDataDir() BEFORE migration.
    // This creates workspace/ and all its subdirs.
    ensureDataDir();

    // Workspace dirs now exist (pre-created by ensureDataDir)
    expect(existsSync(join(ws, 'data'))).toBe(true);
    expect(existsSync(join(ws, 'hooks'))).toBe(true);
    expect(existsSync(join(ws, 'skills'))).toBe(true);

    // Now run migration — this SHOULD still move legacy items.
    // The pre-created empty dirs are the problem: migratePath() sees
    // the destination exists and skips the move.
    migrateToWorkspaceLayout();

    // With the old bug, these would FAIL because migration was skipped.
    // After the fix, ensureDataDir() is never called before migration
    // in any startup path, so this scenario shouldn't occur in production.
    // But this test documents the behavior: if ensureDataDir runs first,
    // migration DOES skip moves for items whose destination dirs exist.
    //
    // The actual fix is ensuring no call site ever calls ensureDataDir()
    // before migration — NOT making migration work after ensureDataDir().
    // This test verifies that the ordering matters.

    // data/ move is skipped because workspace/data/ already exists
    expect(existsSync(join(root, 'data'))).toBe(true);
    expect(existsSync(join(ws, 'data', 'db', 'assistant.db'))).toBe(false);

    // hooks/ directory move is skipped because workspace/hooks/ already exists,
    // but mergeLegacyHooks() moves individual hook files into workspace/hooks/
    expect(existsSync(join(root, 'hooks'))).toBe(true);
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe('#!/bin/bash');

    // skills/ move is skipped because workspace/skills/ already exists
    expect(existsSync(join(root, 'skills'))).toBe(true);

    // But items WITHOUT pre-created destinations DO migrate successfully
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe('{"theme":"dark"}');
    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(false);
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe('# Identity');
    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('# Soul');
    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('# User');

    rmSync(base, { recursive: true, force: true });
  });

  test('correct ordering: migration then ensureDataDir moves everything', () => {
    // The correct startup sequence: migrate first, then ensureDataDir.
    // This is what runDaemon() and loadConfig() now do after the fix.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    // Correct order: migrate, THEN create dirs
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();

    // ALL items should have been migrated
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe('{"theme":"dark"}');

    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe('db-content');
    expect(readFileSync(join(ws, 'data', 'logs', 'vellum.log'), 'utf-8')).toBe('log-content');

    expect(existsSync(join(root, 'hooks'))).toBe(false);
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe('#!/bin/bash');

    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(false);
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe('# Identity');

    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(readFileSync(join(ws, 'skills', 'search.json'), 'utf-8')).toBe('{}');

    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('# Soul');

    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('# User');

    // ensureDataDir should have created standard dirs that didn't exist yet
    expect(existsSync(join(ws, 'data', 'memory'))).toBe(true);
    expect(existsSync(join(ws, 'data', 'qdrant'))).toBe(true);
    expect(existsSync(join(ws, 'data', 'apps'))).toBe(true);
    expect(existsSync(join(ws, 'data', 'interfaces'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  test('ensureDataDir before migration: files without matching dirs still migrate', () => {
    // Even with the wrong ordering, individual files (not dirs) that don't
    // have a pre-created destination still migrate correctly. This test
    // documents which items are affected and which are not.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    // Wrong order
    ensureDataDir();
    migrateToWorkspaceLayout();

    // Individual files at root level DO migrate (ensureDataDir doesn't create them)
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(false);
    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(root, 'USER.md'))).toBe(false);

    // These files are in workspace/
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe('{"theme":"dark"}');
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe('# Identity');
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('# Soul');
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('# User');

    // Directories that ensureDataDir pre-creates are the problem:
    // data/ is NOT migrated because destination exists
    expect(existsSync(join(root, 'data', 'db', 'assistant.db'))).toBe(true);

    // hooks/ and skills/ directory moves are skipped, but their contents
    // are merged by mergeLegacyHooks() and mergeLegacySkills()
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe('#!/bin/bash');
    expect(readFileSync(join(ws, 'skills', 'search.json'), 'utf-8')).toBe('{}');

    rmSync(base, { recursive: true, force: true });
  });

  test('double migration is idempotent regardless of ensureDataDir calls', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    // First run: correct order
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();

    // Snapshot after first migration
    const config = readFileSync(join(ws, 'config.json'), 'utf-8');
    const identity = readFileSync(join(ws, 'IDENTITY.md'), 'utf-8');
    const db = readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8');

    // Second run: should be a no-op even with ensureDataDir between migrations
    ensureDataDir();
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();

    // Everything should be unchanged
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(config);
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe(identity);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe(db);

    rmSync(base, { recursive: true, force: true });
  });
});
