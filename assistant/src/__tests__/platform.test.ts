import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ensureDataDir,
  getDataDir,
  getDbPath,
  getHistoryPath,
  getHooksDir,
  getInterfacesDir,
  getIpcBlobDir,
  getLogPath,
  getPidPath,
  getRootDir,
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
} from '../util/platform.js';

const originalBaseDataDir = process.env.BASE_DATA_DIR;

afterEach(() => {
  if (originalBaseDataDir == null) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = originalBaseDataDir;
  }
});

// Baseline path characterization: documents current pre-migration path layout.
// After workspace migration, paths marked "WILL MOVE" below will resolve under
// ~/.vellum/workspace/ instead. Paths marked "STAYS ROOT" remain at ~/.vellum/.
describe('baseline path characterization (pre-migration)', () => {
  test('all path helpers resolve to expected pre-migration locations', () => {
    const base = join(tmpdir(), `platform-test-${randomBytes(4).toString('hex')}`);
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const data = join(root, 'data');

    // Root dir — stays as anchor for all paths
    expect(getRootDir()).toBe(root);

    // WILL MOVE to ~/.vellum/workspace/data
    expect(getDataDir()).toBe(join(root, 'data'));

    // WILL MOVE (under workspace/data)
    expect(getDbPath()).toBe(join(data, 'db', 'assistant.db'));
    expect(getLogPath()).toBe(join(data, 'logs', 'vellum.log'));
    expect(getHistoryPath()).toBe(join(data, 'history'));
    expect(getIpcBlobDir()).toBe(join(data, 'ipc-blobs'));
    expect(getInterfacesDir()).toBe(join(data, 'interfaces'));
    expect(getSandboxRootDir()).toBe(join(data, 'sandbox'));
    expect(getSandboxWorkingDir()).toBe(join(data, 'sandbox', 'fs'));

    // WILL MOVE to ~/.vellum/workspace/hooks
    expect(getHooksDir()).toBe(join(root, 'hooks'));

    // STAYS ROOT — runtime files remain at ~/.vellum/
    expect(getPidPath()).toBe(join(root, 'vellum.pid'));
  });

  test('ensureDataDir creates all expected directories', () => {
    const base = join(tmpdir(), `platform-test-${randomBytes(4).toString('hex')}`);
    process.env.BASE_DATA_DIR = base;
    const rootDir = getRootDir();

    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }

    ensureDataDir();

    // Root-level dirs
    expect(existsSync(getRootDir())).toBe(true);
    expect(existsSync(join(getRootDir(), 'skills'))).toBe(true);
    expect(existsSync(join(getRootDir(), 'hooks'))).toBe(true);
    expect(existsSync(join(getRootDir(), 'protected'))).toBe(true);

    // Data sub-dirs
    expect(existsSync(getDataDir())).toBe(true);
    expect(existsSync(join(getDataDir(), 'db'))).toBe(true);
    expect(existsSync(join(getDataDir(), 'qdrant'))).toBe(true);
    expect(existsSync(join(getDataDir(), 'logs'))).toBe(true);
    expect(existsSync(join(getDataDir(), 'memory'))).toBe(true);
    expect(existsSync(join(getDataDir(), 'memory', 'knowledge'))).toBe(true);
    expect(existsSync(join(getDataDir(), 'apps'))).toBe(true);
    expect(existsSync(getSandboxRootDir())).toBe(true);
    expect(existsSync(getSandboxWorkingDir())).toBe(true);
    expect(existsSync(getInterfacesDir())).toBe(true);

    rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('workspace path primitives', () => {
  test('workspace helpers resolve under getRootDir()/workspace', () => {
    const base = join(tmpdir(), `platform-test-${randomBytes(4).toString('hex')}`);
    process.env.BASE_DATA_DIR = base;
    const root = join(base, '.vellum');
    const ws = join(root, 'workspace');

    expect(getWorkspaceDir()).toBe(ws);
    expect(getWorkspaceConfigPath()).toBe(join(ws, 'config.json'));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, 'skills'));
    expect(getWorkspaceHooksDir()).toBe(join(ws, 'hooks'));
    expect(getWorkspacePromptPath('IDENTITY.md')).toBe(join(ws, 'IDENTITY.md'));
    expect(getWorkspacePromptPath('SOUL.md')).toBe(join(ws, 'SOUL.md'));
    expect(getWorkspacePromptPath('USER.md')).toBe(join(ws, 'USER.md'));
  });

  test('workspace helpers honor BASE_DATA_DIR', () => {
    process.env.BASE_DATA_DIR = '/tmp/custom-base';
    expect(getWorkspaceDir()).toBe('/tmp/custom-base/.vellum/workspace');
  });
});
