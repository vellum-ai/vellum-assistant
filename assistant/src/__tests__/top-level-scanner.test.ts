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

  test('returns empty array for empty directory', () => {
    const result = scanTopLevelDirectories(tempDir);
    expect(result.rootPath).toBe(tempDir);
    expect(result.directories).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('returns only directories, not files', () => {
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'lib'));
    writeFileSync(join(tempDir, 'README.md'), 'hello');
    writeFileSync(join(tempDir, 'package.json'), '{}');

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['lib', 'src']);
    expect(result.truncated).toBe(false);
  });

  test('sorts directories lexicographically', () => {
    mkdirSync(join(tempDir, 'zebra'));
    mkdirSync(join(tempDir, 'alpha'));
    mkdirSync(join(tempDir, 'middle'));

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['alpha', 'middle', 'zebra']);
  });

  test('includes hidden directories', () => {
    mkdirSync(join(tempDir, '.git'));
    mkdirSync(join(tempDir, '.vscode'));
    mkdirSync(join(tempDir, 'src'));

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['.git', '.vscode', 'src']);
  });

  test('is non-recursive — does not descend into subdirectories', () => {
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'src', 'nested'));
    mkdirSync(join(tempDir, 'src', 'nested', 'deep'));

    const result = scanTopLevelDirectories(tempDir);
    expect(result.directories).toEqual(['src']);
  });

  test('is deterministic — same input produces same output', () => {
    mkdirSync(join(tempDir, 'b'));
    mkdirSync(join(tempDir, 'a'));
    mkdirSync(join(tempDir, 'c'));

    const r1 = scanTopLevelDirectories(tempDir);
    const r2 = scanTopLevelDirectories(tempDir);
    expect(r1).toEqual(r2);
  });

  test('returns truncated=true when exceeding MAX_TOP_LEVEL_ENTRIES', () => {
    for (let i = 0; i < MAX_TOP_LEVEL_ENTRIES + 5; i++) {
      mkdirSync(join(tempDir, `dir-${String(i).padStart(4, '0')}`));
    }

    const result = scanTopLevelDirectories(tempDir);
    expect(result.truncated).toBe(true);
    expect(result.directories).toHaveLength(MAX_TOP_LEVEL_ENTRIES);
  });

  test('returns truncated=false at exactly MAX_TOP_LEVEL_ENTRIES', () => {
    for (let i = 0; i < MAX_TOP_LEVEL_ENTRIES; i++) {
      mkdirSync(join(tempDir, `dir-${String(i).padStart(4, '0')}`));
    }

    const result = scanTopLevelDirectories(tempDir);
    expect(result.truncated).toBe(false);
    expect(result.directories).toHaveLength(MAX_TOP_LEVEL_ENTRIES);
  });

  test('handles non-existent rootPath gracefully', () => {
    const result = scanTopLevelDirectories('/tmp/non-existent-path-abc123');
    expect(result.rootPath).toBe('/tmp/non-existent-path-abc123');
    expect(result.directories).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
