import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hostFileWriteTool } from '../tools/host-filesystem/write.js';
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

describe('host_file_write tool', () => {
  test('rejects relative paths', async () => {
    const result = await hostFileWriteTool.execute({ path: 'relative.txt', content: 'hi' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('must be absolute');
  });

  test('rejects non-string content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-write-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'out.txt');

    const result = await hostFileWriteTool.execute({ path: filePath, content: 42 }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('content is required and must be a string');
  });

  test('writes new file and returns diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-write-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'nested', 'new.txt');

    const result = await hostFileWriteTool.execute({ path: filePath, content: 'new content' }, makeContext());

    expect(result.isError).toBe(false);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('new content');
    expect(result.diff).toEqual({
      filePath,
      oldContent: '',
      newContent: 'new content',
      isNewFile: true,
    });
  });

  test('overwrites existing file and returns previous content in diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-write-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'existing.txt');

    await hostFileWriteTool.execute({ path: filePath, content: 'old' }, makeContext());
    const result = await hostFileWriteTool.execute({ path: filePath, content: 'updated' }, makeContext());

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('updated');
    expect(result.diff).toEqual({
      filePath,
      oldContent: 'old',
      newContent: 'updated',
      isNewFile: false,
    });
  });
});
