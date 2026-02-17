import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeDirPath,
  normalizeFilePath,
  isSkillSourcePath,
} from '../skills/path-classifier.js';

describe('normalizeDirPath symlink resolution for non-existent paths', () => {
  let realDir: string;
  let symlinkDir: string;

  beforeAll(() => {
    // Create a real temp directory and a symlink pointing to it.
    // Resolve realDir through realpathSync because tmpdir() may itself
    // traverse symlinks (e.g. /var → /private/var on macOS).
    const raw = mkdtempSync(join(tmpdir(), 'path-classifier-real-'));
    realDir = realpathSync(raw);
    symlinkDir = realDir + '-link';
    symlinkSync(realDir, symlinkDir);
  });

  afterAll(() => {
    rmSync(symlinkDir);
    rmSync(realDir, { recursive: true });
  });

  test('resolves symlink ancestor when target dir does not exist', () => {
    const nonExistent = join(symlinkDir, 'nonexistent');
    const normalized = normalizeDirPath(nonExistent);

    // Should resolve through the symlink to the real path
    expect(normalized.startsWith(realDir)).toBe(true);
    expect(normalized).toContain('nonexistent');
    expect(normalized.endsWith('/')).toBe(true);
  });

  test('normalizeDirPath and normalizeFilePath agree on symlinked prefix', () => {
    const nonExistentDir = join(symlinkDir, 'nonexistent');
    const nonExistentFile = join(symlinkDir, 'nonexistent', 'file.ts');

    const dirNorm = normalizeDirPath(nonExistentDir);
    const fileNorm = normalizeFilePath(nonExistentFile);

    // Both should resolve through the symlink, so file path starts with dir path
    expect(fileNorm.startsWith(dirNorm)).toBe(true);
  });

  test('isSkillSourcePath matches file under symlinked extra root', () => {
    const extraRoot = join(symlinkDir, 'nonexistent');
    const filePath = join(symlinkDir, 'nonexistent', 'my-skill', 'tool.ts');

    expect(isSkillSourcePath(filePath, [extraRoot])).toBe(true);
  });

  test('normalizeDirPath resolves existing path through symlink', () => {
    // The symlink dir itself exists, so this should resolve via realpathSync
    const normalized = normalizeDirPath(symlinkDir);
    expect(normalized.startsWith(realDir)).toBe(true);
    expect(normalized.endsWith('/')).toBe(true);
  });

  test('normalizeDirPath handles deeply nested non-existent paths', () => {
    const deep = join(symlinkDir, 'a', 'b', 'c', 'd');
    const normalized = normalizeDirPath(deep);

    expect(normalized.startsWith(realDir)).toBe(true);
    expect(normalized).toContain(join('a', 'b', 'c', 'd'));
    expect(normalized.endsWith('/')).toBe(true);
  });
});
