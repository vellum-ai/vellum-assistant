import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mock, spyOn } from 'bun:test';

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

/** Mock Bun.spawn so runClawhub succeeds without a real subprocess. */
function mockSpawnSuccess(): ReturnType<typeof spyOn> {
  return spyOn(Bun, 'spawn').mockImplementation(() => {
    const empty = new ReadableStream({ start(c) { c.close(); } });
    return {
      stdout: empty,
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill: () => {},
      pid: 0,
    } as unknown as ReturnType<typeof Bun.spawn>;
  });
}

/** Create a fake skill directory with a file so verifyAndRecordSkillHash can compute a hash. */
function createFakeSkill(slug: string): void {
  const skillDir = join(TEST_DIR, 'skills', slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill\n', 'utf-8');
}

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
// Integrity manifest edge cases — mocks Bun.spawn so verifyAndRecordSkillHash
// actually runs after a simulated successful install.
// ---------------------------------------------------------------------------

describe('integrity manifest', () => {
  test('malformed integrity JSON is replaced with a fresh manifest on install', async () => {
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    writeFileSync(integrityPath, '{not valid json!!!', 'utf-8');
    createFakeSkill('valid-slug');

    const spy = mockSpawnSuccess();
    try {
      const result = await clawhubInstall('valid-slug');
      expect(result.success).toBe(true);
      // verifyAndRecordSkillHash should have written a valid manifest
      const manifest = JSON.parse(readFileSync(integrityPath, 'utf-8'));
      expect(manifest['valid-slug']).toBeDefined();
      expect(manifest['valid-slug'].sha256).toMatch(/^v2:/);
    } finally {
      spy.mockRestore();
    }
  });

  test('missing integrity manifest is created on first install', async () => {
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    expect(existsSync(integrityPath)).toBe(false);
    createFakeSkill('fresh-skill');

    const spy = mockSpawnSuccess();
    try {
      const result = await clawhubInstall('fresh-skill');
      expect(result.success).toBe(true);
      expect(existsSync(integrityPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(integrityPath, 'utf-8'));
      expect(manifest['fresh-skill']).toBeDefined();
      expect(manifest['fresh-skill'].sha256).toMatch(/^v2:/);
      expect(manifest['fresh-skill'].installedAt).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('re-install with same content preserves hash without error', async () => {
    createFakeSkill('stable-skill');
    const spy = mockSpawnSuccess();
    try {
      // First install — seeds the manifest
      const first = await clawhubInstall('stable-skill');
      expect(first.success).toBe(true);

      // Second install with identical content — should succeed
      const second = await clawhubInstall('stable-skill');
      expect(second.success).toBe(true);

      const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
      const manifest = JSON.parse(readFileSync(integrityPath, 'utf-8'));
      expect(manifest['stable-skill'].sha256).toMatch(/^v2:/);
    } finally {
      spy.mockRestore();
    }
  });
});
