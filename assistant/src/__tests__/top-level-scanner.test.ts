import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scanTopLevelDirectories, MAX_TOP_LEVEL_ENTRIES } from '../workspace/top-level-scanner.js';

describe('scanTopLevelDirectories', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scanner-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns empty arrays for empty directory', () => {
    const result = scanTopLevelDirectories(tempDir);
    expect(result.rootPath).toBe(tempDir);
    expect(result.directories).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('separates directories and files', () => {
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'lib'));
    writeFileSync(join(tempDir, 'README.md'), 'hello');
    writeFileSync(join(tempDir, 'package.json'), '{}');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['lib', 'src']);
    expect(result.files).toEqual(['README.md', 'package.json']);
    expect(result.truncated).toBe(false);
  });

  test('sorts directories lexicographically', () => {
    mkdirSync(join(tempDir, 'zebra'));
    mkdirSync(join(tempDir, 'alpha'));
    mkdirSync(join(tempDir, 'middle'));

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['alpha', 'middle', 'zebra']);
  });

  test('sorts files lexicographically', () => {
    writeFileSync(join(tempDir, 'z.txt'), '');
    writeFileSync(join(tempDir, 'a.txt'), '');
    writeFileSync(join(tempDir, 'm.txt'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.files).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });

  test('includes hidden directories', () => {
    mkdirSync(join(tempDir, '.git'));
    mkdirSync(join(tempDir, '.vscode'));
    mkdirSync(join(tempDir, 'src'));

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['.git', '.vscode', 'src']);
  });

  test('includes hidden files', () => {
    writeFileSync(join(tempDir, '.gitignore'), '');
    writeFileSync(join(tempDir, '.env'), '');
    writeFileSync(join(tempDir, 'index.ts'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.files).toEqual(['.env', '.gitignore', 'index.ts']);
  });

  test('is non-recursive — does not descend into subdirectories', () => {
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'src', 'nested'));
    mkdirSync(join(tempDir, 'src', 'nested', 'deep'));
    writeFileSync(join(tempDir, 'src', 'index.ts'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['src']);
    expect(result.files).toEqual([]);
  });

  test('is deterministic — same input produces same output', () => {
    mkdirSync(join(tempDir, 'b'));
    mkdirSync(join(tempDir, 'a'));
    mkdirSync(join(tempDir, 'c'));
    writeFileSync(join(tempDir, 'x.txt'), '');

    const r1 = scanTopLevelDirectories(tempDir);
    const r2 = scanTopLevelDirectories(tempDir);
    expect(r1).toEqual(r2);
  });

  test('returns truncated=true when total entries exceed MAX_TOP_LEVEL_ENTRIES', () => {
    for (let i = 0; i < MAX_TOP_LEVEL_ENTRIES; i++) {
      mkdirSync(join(tempDir, `dir-${String(i).padStart(4, '0')}`));
    }
    writeFileSync(join(tempDir, 'extra.txt'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.truncated).toBe(true);
    expect(result.directories.length + result.files.length).toBeLessThanOrEqual(MAX_TOP_LEVEL_ENTRIES);
  });

  test('returns truncated=false at exactly MAX_TOP_LEVEL_ENTRIES total', () => {
    const dirCount = MAX_TOP_LEVEL_ENTRIES - 2;
    for (let i = 0; i < dirCount; i++) {
      mkdirSync(join(tempDir, `dir-${String(i).padStart(4, '0')}`));
    }
    writeFileSync(join(tempDir, 'a.txt'), '');
    writeFileSync(join(tempDir, 'b.txt'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.truncated).toBe(false);
    expect(result.directories).toHaveLength(dirCount);
    expect(result.files).toHaveLength(2);
  });

  test('prioritizes directories over files when truncating', () => {
    for (let i = 0; i < MAX_TOP_LEVEL_ENTRIES; i++) {
      mkdirSync(join(tempDir, `dir-${String(i).padStart(4, '0')}`));
    }
    writeFileSync(join(tempDir, 'file.txt'), '');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.truncated).toBe(true);
    expect(result.directories).toHaveLength(MAX_TOP_LEVEL_ENTRIES);
    expect(result.files).toHaveLength(0);
  });

  test('handles non-existent rootPath gracefully', () => {
    const result = scanTopLevelDirectories('/tmp/non-existent-path-abc123');
    expect(result.rootPath).toBe('/tmp/non-existent-path-abc123');
    expect(result.directories).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
