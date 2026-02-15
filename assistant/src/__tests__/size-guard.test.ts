import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_FILE_SIZE_BYTES,
  checkFileSizeOnDisk,
  checkContentSize,
} from '../tools/shared/filesystem/size-guard.js';

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'size-guard-test-')));
  testDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// MAX_FILE_SIZE_BYTES
// ---------------------------------------------------------------------------

describe('MAX_FILE_SIZE_BYTES', () => {
  test('equals 100 MB', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// checkFileSizeOnDisk
// ---------------------------------------------------------------------------

describe('checkFileSizeOnDisk', () => {
  test('returns undefined for a file within the default limit', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'small.txt');
    writeFileSync(filePath, 'hello');

    expect(checkFileSizeOnDisk(filePath)).toBeUndefined();
  });

  test('returns error string for a file exceeding a custom limit', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'big.txt');
    writeFileSync(filePath, 'x'.repeat(200));

    const result = checkFileSizeOnDisk(filePath, 100);
    expect(result).toBeDefined();
    expect(result).toContain('exceeds');
    expect(result).toContain('limit');
    expect(result).toContain(filePath);
  });

  test('returns undefined for a file exactly at the custom limit', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'exact.txt');
    writeFileSync(filePath, 'x'.repeat(100));

    expect(checkFileSizeOnDisk(filePath, 100)).toBeUndefined();
  });

  test('uses default limit when none is provided', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'tiny.txt');
    writeFileSync(filePath, 'a');

    // Should not error since 1 byte is well under 100 MB
    expect(checkFileSizeOnDisk(filePath)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkContentSize
// ---------------------------------------------------------------------------

describe('checkContentSize', () => {
  test('returns undefined for content within the default limit', () => {
    expect(checkContentSize('hello', '/tmp/test.txt')).toBeUndefined();
  });

  test('returns error string for content exceeding a custom limit', () => {
    const content = 'x'.repeat(200);
    const result = checkContentSize(content, '/tmp/big.txt', 100);
    expect(result).toBeDefined();
    expect(result).toContain('exceeds');
    expect(result).toContain('limit');
    expect(result).toContain('/tmp/big.txt');
  });

  test('returns undefined for content exactly at the custom limit', () => {
    const content = 'x'.repeat(100);
    expect(checkContentSize(content, '/tmp/exact.txt', 100)).toBeUndefined();
  });

  test('measures byte length, not string length', () => {
    // Multi-byte character: each emoji is 4 bytes in UTF-8
    const emoji = '\u{1F600}'; // 4 bytes
    expect(emoji.length).toBe(2); // JS string length (surrogate pair)
    expect(Buffer.byteLength(emoji, 'utf-8')).toBe(4);

    // Allow 3 bytes — the emoji should exceed it
    const result = checkContentSize(emoji, '/tmp/emoji.txt', 3);
    expect(result).toBeDefined();
    expect(result).toContain('exceeds');
  });

  test('uses default limit when none is provided', () => {
    expect(checkContentSize('a', '/tmp/test.txt')).toBeUndefined();
  });
});

