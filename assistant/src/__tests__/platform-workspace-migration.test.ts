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

import { migrateToWorkspaceLayout } from '../util/platform.js';

const originalBaseDataDir = process.env.BASE_DATA_DIR;

function makeTmpBase(): string {
  const base = join(
    tmpdir(),
    `ws-migration-test-${randomBytes(4).toString('hex')}`,
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
});

/**
 * Populate a fake ~/.vellum directory with all legacy items that the
 * migration is expected to relocate.
 */
function populateLegacyLayout(root: string): void {
  mkdirSync(root, { recursive: true });

  // data dir with sandbox/fs content
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'sandbox', 'fs', 'project'), { recursive: true });
  writeFileSync(join(dataDir, 'sandbox', 'fs', 'hello.txt'), 'sandbox-file');
  writeFileSync(
    join(dataDir, 'sandbox', 'fs', 'project', 'main.ts'),
    'project-code',
  );
  mkdirSync(join(dataDir, 'db'), { recursive: true });
  writeFileSync(join(dataDir, 'db', 'assistant.db'), 'db-content');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'logs', 'vellum.log'), 'log-content');

  // config.json
  writeFileSync(join(root, 'config.json'), '{"theme":"dark"}');

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

  // runtime files that should NOT move
  writeFileSync(join(root, 'vellum.sock'), 'socket-placeholder');
  writeFileSync(join(root, 'vellum.pid'), '12345');
}

describe('migrateToWorkspaceLayout', () => {
  test('full legacy migration moves all items into workspace/', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    migrateToWorkspaceLayout();

    // (a) sandbox/fs content was extracted to become workspace root
    expect(existsSync(ws)).toBe(true);
    expect(readFileSync(join(ws, 'hello.txt'), 'utf-8')).toBe('sandbox-file');
    expect(readFileSync(join(ws, 'project', 'main.ts'), 'utf-8')).toBe(
      'project-code',
    );
    // Original sandbox/fs should be gone (renamed)
    expect(existsSync(join(root, 'data', 'sandbox', 'fs'))).toBe(false);

    // (b) config.json moved
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      '{"theme":"dark"}',
    );

    // (c) data dir moved
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(
      readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8'),
    ).toBe('db-content');
    expect(
      readFileSync(join(ws, 'data', 'logs', 'vellum.log'), 'utf-8'),
    ).toBe('log-content');

    // (d) hooks moved
    expect(existsSync(join(root, 'hooks'))).toBe(false);
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe(
      '#!/bin/bash',
    );

    // (e) IDENTITY.md moved
    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(false);
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe('# Identity');

    // (f) skills moved
    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(readFileSync(join(ws, 'skills', 'search.json'), 'utf-8')).toBe(
      '{}',
    );

    // (g) SOUL.md moved
    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('# Soul');

    // (h) USER.md moved
    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('# User');

    rmSync(base, { recursive: true, force: true });
  });

  test('idempotent: second run is a no-op', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyLayout(root);

    // First run
    migrateToWorkspaceLayout();

    // Snapshot workspace state after first run
    const configAfterFirst = readFileSync(join(ws, 'config.json'), 'utf-8');
    const identityAfterFirst = readFileSync(join(ws, 'IDENTITY.md'), 'utf-8');

    // Second run — should not throw and should not change anything
    migrateToWorkspaceLayout();

    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      configAfterFirst,
    );
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe(
      identityAfterFirst,
    );
    expect(existsSync(join(ws, 'data', 'db', 'assistant.db'))).toBe(true);
    expect(existsSync(join(ws, 'hooks', 'on-start.sh'))).toBe(true);
    expect(existsSync(join(ws, 'skills', 'search.json'))).toBe(true);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('# Soul');
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('# User');

    rmSync(base, { recursive: true, force: true });
  });

  test('destination conflict leaves source intact', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Create workspace dir with conflicting content already in place
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), 'existing-config');
    writeFileSync(join(ws, 'IDENTITY.md'), 'existing-identity');

    // Create legacy items that should NOT overwrite existing workspace items
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), 'legacy-config');
    writeFileSync(join(root, 'IDENTITY.md'), 'legacy-identity');

    migrateToWorkspaceLayout();

    // Workspace content should be unchanged (not overwritten)
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      'existing-config',
    );
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe(
      'existing-identity',
    );

    // Source files should still exist (not moved because destination existed)
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    expect(readFileSync(join(root, 'config.json'), 'utf-8')).toBe(
      'legacy-config',
    );
    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(true);
    expect(readFileSync(join(root, 'IDENTITY.md'), 'utf-8')).toBe(
      'legacy-identity',
    );

    rmSync(base, { recursive: true, force: true });
  });

  test('root runtime files (vellum.sock, vellum.pid) are unaffected', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');

    populateLegacyLayout(root);

    migrateToWorkspaceLayout();

    // Runtime files should remain at root level
    expect(existsSync(join(root, 'vellum.sock'))).toBe(true);
    expect(readFileSync(join(root, 'vellum.sock'), 'utf-8')).toBe(
      'socket-placeholder',
    );
    expect(existsSync(join(root, 'vellum.pid'))).toBe(true);
    expect(readFileSync(join(root, 'vellum.pid'), 'utf-8')).toBe('12345');

    rmSync(base, { recursive: true, force: true });
  });

  test('partially migrated tree: completes remaining items without touching already-migrated ones', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Simulate a partial migration: workspace already exists with some items,
    // but other legacy items are still at root level.
    mkdirSync(ws, { recursive: true });

    // Already migrated: config.json and IDENTITY.md are in workspace
    writeFileSync(join(ws, 'config.json'), 'already-migrated-config');
    writeFileSync(join(ws, 'IDENTITY.md'), 'already-migrated-identity');

    // Not yet migrated: hooks, skills, SOUL.md, USER.md still at root
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'on-start.sh'), 'legacy-hook');
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'search.json'), 'legacy-skill');
    writeFileSync(join(root, 'SOUL.md'), 'legacy-soul');
    writeFileSync(join(root, 'USER.md'), 'legacy-user');

    // Also leave a data dir at root (not yet migrated)
    mkdirSync(join(root, 'data', 'db'), { recursive: true });
    writeFileSync(join(root, 'data', 'db', 'assistant.db'), 'legacy-db');

    migrateToWorkspaceLayout();

    // Already-migrated items should be untouched
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      'already-migrated-config',
    );
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe(
      'already-migrated-identity',
    );

    // Remaining items should now be migrated into workspace
    expect(existsSync(join(root, 'hooks'))).toBe(false);
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe(
      'legacy-hook',
    );
    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(readFileSync(join(ws, 'skills', 'search.json'), 'utf-8')).toBe(
      'legacy-skill',
    );
    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('legacy-soul');
    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    expect(readFileSync(join(ws, 'USER.md'), 'utf-8')).toBe('legacy-user');
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe(
      'legacy-db',
    );

    rmSync(base, { recursive: true, force: true });
  });

  test('destination directory conflicts: existing workspace dirs are not overwritten', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Pre-existing workspace directories with content
    mkdirSync(join(ws, 'hooks'), { recursive: true });
    writeFileSync(join(ws, 'hooks', 'existing-hook.sh'), 'ws-hook');
    mkdirSync(join(ws, 'skills'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'existing-skill.json'), 'ws-skill');
    mkdirSync(join(ws, 'data', 'db'), { recursive: true });
    writeFileSync(join(ws, 'data', 'db', 'assistant.db'), 'ws-db');

    // Legacy items at root that would conflict with workspace dirs
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'legacy-hook.sh'), 'root-hook');
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'legacy-skill.json'), 'root-skill');
    mkdirSync(join(root, 'data', 'logs'), { recursive: true });
    writeFileSync(join(root, 'data', 'logs', 'vellum.log'), 'root-log');

    migrateToWorkspaceLayout();

    // Workspace directories should retain their original content
    expect(readFileSync(join(ws, 'hooks', 'existing-hook.sh'), 'utf-8')).toBe(
      'ws-hook',
    );
    expect(
      readFileSync(join(ws, 'skills', 'existing-skill.json'), 'utf-8'),
    ).toBe('ws-skill');
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe(
      'ws-db',
    );

    // Legacy hooks/skills/data should remain at root (not moved due to conflict)
    expect(existsSync(join(root, 'hooks', 'legacy-hook.sh'))).toBe(true);
    expect(readFileSync(join(root, 'hooks', 'legacy-hook.sh'), 'utf-8')).toBe(
      'root-hook',
    );
    expect(existsSync(join(root, 'skills', 'legacy-skill.json'))).toBe(true);
    expect(
      readFileSync(join(root, 'skills', 'legacy-skill.json'), 'utf-8'),
    ).toBe('root-skill');
    // data dir is also left in place
    expect(existsSync(join(root, 'data', 'logs', 'vellum.log'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  test('stale empty directories from a previous failed run do not cause errors', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Simulate aftermath of a partial migration: workspace already has
    // the real content, but empty leftover dirs remain at root.
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), 'migrated-config');

    // Empty stale directories at root (e.g. sandbox dir after fs was moved out)
    mkdirSync(join(root, 'data', 'sandbox'), { recursive: true });
    // Empty hooks dir
    mkdirSync(join(root, 'hooks'), { recursive: true });
    // Empty skills dir
    mkdirSync(join(root, 'skills'), { recursive: true });

    // Migration should not throw
    expect(() => migrateToWorkspaceLayout()).not.toThrow();

    // Workspace content should be preserved
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      'migrated-config',
    );

    // The empty stale dirs that didn't conflict should be moved into workspace
    // (data/ moves because ws/data doesn't exist yet)
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(existsSync(join(ws, 'data', 'sandbox'))).toBe(true);

    // hooks and skills: moved successfully since no ws/hooks or ws/skills existed
    expect(existsSync(join(root, 'hooks'))).toBe(false);
    expect(existsSync(join(ws, 'hooks'))).toBe(true);
    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(existsSync(join(ws, 'skills'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  test('stale empty dirs at root with existing workspace counterparts are harmless', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Workspace already fully set up
    mkdirSync(join(ws, 'hooks'), { recursive: true });
    writeFileSync(join(ws, 'hooks', 'real-hook.sh'), 'hook-content');
    mkdirSync(join(ws, 'skills'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'real-skill.json'), 'skill-content');
    mkdirSync(join(ws, 'data'), { recursive: true });

    // Stale empty dirs at root that conflict with workspace dirs
    mkdirSync(join(root, 'hooks'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });

    // Should not throw
    expect(() => migrateToWorkspaceLayout()).not.toThrow();

    // Workspace content untouched
    expect(readFileSync(join(ws, 'hooks', 'real-hook.sh'), 'utf-8')).toBe(
      'hook-content',
    );
    expect(
      readFileSync(join(ws, 'skills', 'real-skill.json'), 'utf-8'),
    ).toBe('skill-content');

    // Stale root dirs remain (skipped due to destination conflict)
    expect(existsSync(join(root, 'hooks'))).toBe(true);
    expect(existsSync(join(root, 'skills'))).toBe(true);
    expect(existsSync(join(root, 'data'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  test('protected/ directory at root is never touched by migration', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');

    populateLegacyLayout(root);

    // Add a protected directory with sensitive content
    mkdirSync(join(root, 'protected'), { recursive: true });
    writeFileSync(join(root, 'protected', 'trust.json'), '{"rules":[]}');
    writeFileSync(join(root, 'protected', 'keys.enc'), 'encrypted-keys');

    migrateToWorkspaceLayout();

    // protected/ should remain exactly at root, untouched
    expect(existsSync(join(root, 'protected'))).toBe(true);
    expect(
      readFileSync(join(root, 'protected', 'trust.json'), 'utf-8'),
    ).toBe('{"rules":[]}');
    expect(readFileSync(join(root, 'protected', 'keys.enc'), 'utf-8')).toBe(
      'encrypted-keys',
    );

    // It should NOT appear in workspace
    expect(existsSync(join(root, 'workspace', 'protected'))).toBe(false);

    // Other items should have migrated normally
    expect(existsSync(join(root, 'workspace', 'IDENTITY.md'))).toBe(true);
    expect(existsSync(join(root, 'workspace', 'SOUL.md'))).toBe(true);

    // Runtime files also untouched
    expect(existsSync(join(root, 'vellum.sock'))).toBe(true);
    expect(existsSync(join(root, 'vellum.pid'))).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });

  test('mixed partial migration with sandbox/fs already extracted', () => {
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // Workspace already exists (sandbox/fs was previously extracted),
    // but some files are still at root awaiting migration.
    mkdirSync(join(ws, 'project'), { recursive: true });
    writeFileSync(join(ws, 'hello.txt'), 'sandbox-file');
    writeFileSync(join(ws, 'project', 'main.ts'), 'project-code');

    // Legacy items still at root
    writeFileSync(join(root, 'config.json'), 'legacy-config');
    writeFileSync(join(root, 'IDENTITY.md'), 'legacy-identity');
    writeFileSync(join(root, 'SOUL.md'), 'legacy-soul');

    // data dir with remaining content (sandbox/fs is gone but rest remains)
    mkdirSync(join(root, 'data', 'db'), { recursive: true });
    writeFileSync(join(root, 'data', 'db', 'assistant.db'), 'legacy-db');
    mkdirSync(join(root, 'data', 'logs'), { recursive: true });
    writeFileSync(join(root, 'data', 'logs', 'vellum.log'), 'legacy-log');

    migrateToWorkspaceLayout();

    // sandbox/fs content (now workspace root content) should be intact
    expect(readFileSync(join(ws, 'hello.txt'), 'utf-8')).toBe('sandbox-file');
    expect(readFileSync(join(ws, 'project', 'main.ts'), 'utf-8')).toBe(
      'project-code',
    );

    // Legacy items should now be in workspace
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(
      'legacy-config',
    );
    expect(readFileSync(join(ws, 'IDENTITY.md'), 'utf-8')).toBe(
      'legacy-identity',
    );
    expect(readFileSync(join(ws, 'SOUL.md'), 'utf-8')).toBe('legacy-soul');
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe(
      'legacy-db',
    );

    // Root should be clean of migrated items
    expect(existsSync(join(root, 'config.json'))).toBe(false);
    expect(existsSync(join(root, 'IDENTITY.md'))).toBe(false);
    expect(existsSync(join(root, 'SOUL.md'))).toBe(false);
    expect(existsSync(join(root, 'data'))).toBe(false);

    rmSync(base, { recursive: true, force: true });
  });
});
