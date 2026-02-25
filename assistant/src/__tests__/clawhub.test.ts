import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mock } from 'bun:test';

let TEST_DIR = '';

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceSkillsDir: () => join(TEST_DIR, 'skills'),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import {
  clawhubInstall,
  clawhubInspect,
} from '../skills/clawhub.js';

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'clawhub-test-'));
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Slug validation (exercised through public API)
// ---------------------------------------------------------------------------

describe('clawhubInstall slug validation', () => {
  test('rejects empty slug', async () => {
    const result = await clawhubInstall('');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug starting with a dot', async () => {
    const result = await clawhubInstall('.hidden');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug starting with a hyphen', async () => {
    const result = await clawhubInstall('-dashed');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug with path traversal', async () => {
    const result = await clawhubInstall('../escape');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug with spaces', async () => {
    const result = await clawhubInstall('my skill');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug with double slash', async () => {
    const result = await clawhubInstall('ns//skill');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug ending with slash', async () => {
    const result = await clawhubInstall('skill/');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug with special characters', async () => {
    const result = await clawhubInstall('skill@latest');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid skill slug');
  });
});

describe('clawhubInspect slug validation', () => {
  test('rejects empty slug', async () => {
    const result = await clawhubInspect('');
    expect(result.error).toContain('Invalid skill slug');
    expect(result.data).toBeUndefined();
  });

  test('rejects slug with path traversal', async () => {
    const result = await clawhubInspect('../../etc/passwd');
    expect(result.error).toContain('Invalid skill slug');
  });

  test('rejects slug with spaces', async () => {
    const result = await clawhubInspect('bad slug');
    expect(result.error).toContain('Invalid skill slug');
  });
});

// ---------------------------------------------------------------------------
// Integrity manifest edge cases (via filesystem)
// ---------------------------------------------------------------------------

describe('integrity manifest', () => {
  test('malformed integrity JSON is handled gracefully on next install', async () => {
    // Write corrupted integrity manifest
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    writeFileSync(integrityPath, '{not valid json!!!', 'utf-8');

    // clawhubInstall will fail because npx clawhub is not available,
    // but it should not crash on malformed manifest. The slug validation
    // passes so it proceeds to runClawhub which will fail.
    const result = await clawhubInstall('valid-slug');
    // Should fail due to subprocess failure, not manifest parse error
    expect(result.success).toBe(false);
    // The error should be about the command failing, not JSON parsing
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain('JSON');
  });

  test('missing integrity manifest file does not block install', async () => {
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    expect(existsSync(integrityPath)).toBe(false);

    // Will fail on subprocess, but should not fail on missing manifest
    const result = await clawhubInstall('valid-slug');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('integrity');
  });
});
