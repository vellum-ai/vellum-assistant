import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hostFileReadTool } from '../tools/host-filesystem/read.js';
import type { ToolContext } from '../tools/types.js';

const testDirs: string[] = [];

function makeContext(): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('host_file_read tool', () => {
  test('rejects relative paths', async () => {
    const result = await hostFileReadTool.execute({ path: 'relative.txt' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('path must be absolute');
  });

  test('reads file with line numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-read-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'sample.txt');
    writeFileSync(filePath, 'first\nsecond\nthird\n');

    const result = await hostFileReadTool.execute({ path: filePath, offset: 2, limit: 2 }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('2  second');
    expect(result.content).toContain('3  third');
  });

  test('returns error when file does not exist', async () => {
    const filePath = join(tmpdir(), `host-file-read-missing-${Date.now()}.txt`);
    const result = await hostFileReadTool.execute({ path: filePath }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  test('returns error when path is a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-read-test-'));
    testDirs.push(dir);
    const nestedDir = join(dir, 'nested');
    mkdirSync(nestedDir, { recursive: true });

    const result = await hostFileReadTool.execute({ path: nestedDir }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('is not a regular file');
  });
});
