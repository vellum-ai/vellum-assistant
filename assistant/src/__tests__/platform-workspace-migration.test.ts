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
});
