import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  ensureDataDir,
  getDataDir,
  getRootDir,
  getSandboxRootDir,
  getSandboxWorkingDir,
} from '../util/platform.js';

const originalBaseDataDir = process.env.BASE_DATA_DIR;

afterEach(() => {
  if (originalBaseDataDir == null) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = originalBaseDataDir;
  }
});

describe('platform sandbox paths', () => {
  test('sandbox helpers are anchored under data dir', () => {
    const base = join(tmpdir(), `platform-test-${randomBytes(4).toString('hex')}`);
    process.env.BASE_DATA_DIR = base;

    expect(getRootDir()).toBe(join(base, '.vellum'));
    expect(getDataDir()).toBe(join(base, '.vellum', 'data'));
    expect(getSandboxRootDir()).toBe(join(base, '.vellum', 'data', 'sandbox'));
    expect(getSandboxWorkingDir()).toBe(join(base, '.vellum', 'data', 'sandbox', 'fs'));
  });

  test('ensureDataDir creates sandbox directories', () => {
    const base = join(tmpdir(), `platform-test-${randomBytes(4).toString('hex')}`);
    process.env.BASE_DATA_DIR = base;
    const rootDir = getRootDir();

    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }

    ensureDataDir();

    expect(existsSync(getSandboxRootDir())).toBe(true);
    expect(existsSync(getSandboxWorkingDir())).toBe(true);

    rmSync(rootDir, { recursive: true, force: true });
  });
});
