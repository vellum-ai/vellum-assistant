import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getTool } from '../tools/registry.js';
import type { Tool, ToolContext } from '../tools/types.js';

let fileReadTool: Tool;
const testDirs: string[] = [];

beforeAll(async () => {
  await import('../tools/filesystem/read.js');
  fileReadTool = getTool('file_read')!;
});

function makeContext(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'file-read-test-')));
  testDirs.push(dir);
  return dir;
}

describe('file_read tool (sandbox)', () => {
  test('reads file with valid relative path in working dir', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'hello.txt');
    writeFileSync(filePath, 'line one\nline two\nline three\n');

    const result = await fileReadTool.execute({ path: 'hello.txt' }, makeContext(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('line one');
    expect(result.content).toContain('line two');
    expect(result.content).toContain('line three');
  });

  test('returns error for missing file', async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute({ path: 'nonexistent.txt' }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  test('rejects directory path', async () => {
    const dir = makeTempDir();
    const nestedDir = join(dir, 'subdir');
    mkdirSync(nestedDir);

    const result = await fileReadTool.execute({ path: 'subdir' }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('is a directory');
  });

  test('rejects path traversal outside working dir', async () => {
    const dir = makeTempDir();

    const result = await fileReadTool.execute({ path: '../../../etc/passwd' }, makeContext(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the working directory');
  });
});
