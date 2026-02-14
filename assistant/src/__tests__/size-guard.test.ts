import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_FILE_SIZE_BYTES,
  checkFileSizeOnDisk,
  checkContentSize,
} from '../tools/shared/filesystem/size-guard.js';

describe('size-guard', () => {
  const testDir = join(tmpdir(), `size-guard-test-${Date.now()}`);
  const smallFile = join(testDir, 'small.txt');
  const largeFile = join(testDir, 'large.txt');

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(smallFile, 'hello');
    // 1025 bytes — just over 1 KB
    writeFileSync(largeFile, Buffer.alloc(1025));
  });

  afterAll(() => {
    try { unlinkSync(smallFile); } catch {}
    try { unlinkSync(largeFile); } catch {}
  });

  describe('MAX_FILE_SIZE_BYTES', () => {
    it('equals 100 MB', () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
    });
  });

  describe('checkFileSizeOnDisk', () => {
    it('returns undefined for a file within the default limit', () => {
      expect(checkFileSizeOnDisk(smallFile)).toBeUndefined();
    });

    it('returns an error when the file exceeds a custom limit', () => {
      const result = checkFileSizeOnDisk(largeFile, 1024);
      expect(result).toBeDefined();
      expect(result).toContain('exceeds');
      expect(result).toContain('1.0 KB');
    });

    it('returns undefined when the file is within a custom limit', () => {
      expect(checkFileSizeOnDisk(largeFile, 2048)).toBeUndefined();
    });
  });

  describe('checkContentSize', () => {
    it('returns undefined for content within the default limit', () => {
      expect(checkContentSize('hello', '/test.txt')).toBeUndefined();
    });

    it('returns an error when content exceeds a custom limit', () => {
      const content = 'x'.repeat(100);
      const result = checkContentSize(content, '/test.txt', 50);
      expect(result).toBeDefined();
      expect(result).toContain('exceeds');
      expect(result).toContain('/test.txt');
    });

    it('returns undefined when content is within a custom limit', () => {
      const content = 'x'.repeat(50);
      expect(checkContentSize(content, '/test.txt', 100)).toBeUndefined();
    });
  });

  describe('backward-compatible re-exports', () => {
    it('re-exports match the shared module', async () => {
      const shim = await import('../tools/filesystem/size-guard.js');
      const shared = await import('../tools/shared/filesystem/size-guard.js');
      expect(shim.MAX_FILE_SIZE_BYTES).toBe(shared.MAX_FILE_SIZE_BYTES);
      expect(shim.checkFileSizeOnDisk).toBe(shared.checkFileSizeOnDisk);
      expect(shim.checkContentSize).toBe(shared.checkContentSize);
    });
  });
});
