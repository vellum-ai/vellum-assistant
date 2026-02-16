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
import {
  loadRawConfig,
  saveRawConfig,
  invalidateConfigCache,
} from '../config/loader.js';

const originalBaseDataDir = process.env.BASE_DATA_DIR;

function makeTmpBase(): string {
  const base = join(
    tmpdir(),
    `migration-cli-test-${randomBytes(4).toString('hex')}`,
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
 * Populate a legacy ~/.vellum directory with config.json and data dir
 * at root level (pre-workspace layout).
 */
function populateLegacyRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ theme: 'dark' }));
  mkdirSync(join(root, 'data', 'db'), { recursive: true });
  writeFileSync(join(root, 'data', 'db', 'assistant.db'), 'db-content');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'on-start.sh'), '#!/bin/bash');
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'search.json'), '{}');
}

describe('CLI-before-daemon migration flows', () => {
  test('loadRawConfig triggers migration and reads legacy config', () => {
    // Simulates: user runs `assistant config get` before daemon start.
    // loadRawConfig must migrate legacy config.json into workspace/ first.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyRoot(root);

    const raw = loadRawConfig();

    // Config should have been read (after migration moves it to workspace)
    expect(raw.theme).toBe('dark');

    // Legacy config.json should no longer be at root
    expect(existsSync(join(root, 'config.json'))).toBe(false);

    // It should be in workspace/
    expect(existsSync(join(ws, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8')).theme).toBe('dark');

    // data/ should also have been migrated
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe('db-content');

    // hooks/ and skills/ should also have been migrated
    expect(existsSync(join(root, 'hooks'))).toBe(false);
    expect(readFileSync(join(ws, 'hooks', 'on-start.sh'), 'utf-8')).toBe('#!/bin/bash');
    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(readFileSync(join(ws, 'skills', 'search.json'), 'utf-8')).toBe('{}');

    rmSync(base, { recursive: true, force: true });
  });

  test('saveRawConfig triggers migration before writing', () => {
    // Simulates: user runs `assistant config set theme light` before daemon start.
    // saveRawConfig must migrate legacy files before writing new config.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyRoot(root);

    saveRawConfig({ theme: 'light' });

    // New config should be in workspace/
    expect(JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8')).theme).toBe('light');

    // Legacy config.json should have been migrated (then overwritten by saveRawConfig)
    expect(existsSync(join(root, 'config.json'))).toBe(false);

    // data/ should have been migrated
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe('db-content');

    rmSync(base, { recursive: true, force: true });
  });

  test('loadRawConfig followed by daemon migration is idempotent', () => {
    // Simulates: user runs CLI config command, then starts daemon.
    // Both trigger migration — second run should be a no-op.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    populateLegacyRoot(root);

    // CLI path (loadRawConfig triggers migration)
    const raw = loadRawConfig();
    expect(raw.theme).toBe('dark');

    // Snapshot state after CLI migration
    const configAfterCli = readFileSync(join(ws, 'config.json'), 'utf-8');
    const dbAfterCli = readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8');

    // Daemon path (explicit migration + ensureDataDir)
    migrateToDataLayout();
    migrateToWorkspaceLayout();
    ensureDataDir();

    // Everything should be unchanged
    expect(readFileSync(join(ws, 'config.json'), 'utf-8')).toBe(configAfterCli);
    expect(readFileSync(join(ws, 'data', 'db', 'assistant.db'), 'utf-8')).toBe(dbAfterCli);

    rmSync(base, { recursive: true, force: true });
  });

  test('saveRawConfig on fresh install (no legacy files) creates workspace config', () => {
    // Simulates: brand new install, user runs `assistant config set` before anything else.
    const base = makeTmpBase();
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    // No legacy files exist — fresh install
    saveRawConfig({ model: 'claude-3-opus' });

    // Config should be in workspace/
    expect(existsSync(join(ws, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8')).model).toBe('claude-3-opus');

    // No stale root config should exist
    expect(existsSync(join(root, 'config.json'))).toBe(false);

    rmSync(base, { recursive: true, force: true });
  });
});
