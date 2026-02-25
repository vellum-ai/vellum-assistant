import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
// Integrity manifest edge cases — mock Bun.spawn so install succeeds and
// verifyAndRecordSkillHash actually runs.
// ---------------------------------------------------------------------------

/** Mock Bun.spawn to simulate a successful clawhub install (exit code 0). */
function mockSuccessfulSpawn(): ReturnType<typeof spyOn> {
  return spyOn(Bun, 'spawn').mockImplementation((() => {
    const emptyStream = new ReadableStream({ start(c) { c.close(); } });
    return {
      stdout: emptyStream,
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill: () => {},
      pid: 0,
    };
  }) as Parameters<typeof Bun.spawn>[0] as never);
}

describe('integrity manifest', () => {
  test('malformed integrity JSON is replaced with fresh manifest on install', async () => {
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    writeFileSync(integrityPath, '{not valid json!!!', 'utf-8');

    // Create a skill directory so computeSkillHash produces a real hash
    const skillDir = join(TEST_DIR, 'skills', 'valid-slug');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill', 'utf-8');

    const spy = mockSuccessfulSpawn();
    try {
      const result = await clawhubInstall('valid-slug');
      expect(result.success).toBe(true);

      // The malformed manifest should have been replaced with a valid one
      const manifest = JSON.parse(readFileSync(integrityPath, 'utf-8'));
      expect(manifest['valid-slug']).toBeDefined();
      expect(manifest['valid-slug'].sha256).toMatch(/^v2:[0-9a-f]{64}$/);
      expect(manifest['valid-slug'].installedAt).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('missing integrity manifest is created on first install', async () => {
    const integrityPath = join(TEST_DIR, 'skills', '.integrity.json');
    expect(existsSync(integrityPath)).toBe(false);

    // Create a skill directory so computeSkillHash produces a real hash
    const skillDir = join(TEST_DIR, 'skills', 'new-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'index.js'), 'console.log("hi")', 'utf-8');

    const spy = mockSuccessfulSpawn();
    try {
      const result = await clawhubInstall('new-skill');
      expect(result.success).toBe(true);

      // Manifest should now exist with the skill's hash
      expect(existsSync(integrityPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(integrityPath, 'utf-8'));
      expect(manifest['new-skill']).toBeDefined();
      expect(manifest['new-skill'].sha256).toMatch(/^v2:[0-9a-f]{64}$/);
    } finally {
      spy.mockRestore();
    }
  });
});
