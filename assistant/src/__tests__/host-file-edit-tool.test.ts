import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hostFileEditTool } from '../tools/host-filesystem/edit.js';
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

describe('host_file_edit tool', () => {
  test('rejects relative paths', async () => {
    const result = await hostFileEditTool.execute({
      path: 'relative.txt',
      old_string: 'a',
      new_string: 'b',
    }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('path must be absolute');
  });

  test('edits unique match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-edit-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'sample.txt');
    writeFileSync(filePath, 'hello world\n');

    const result = await hostFileEditTool.execute({
      path: filePath,
      old_string: 'hello world',
      new_string: 'updated',
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('updated\n');
    expect(result.diff?.isNewFile).toBe(false);
  });

  test('replace_all edits all matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-edit-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'sample.txt');
    writeFileSync(filePath, 'x\ny\nx\n');

    const result = await hostFileEditTool.execute({
      path: filePath,
      old_string: 'x',
      new_string: 'z',
      replace_all: true,
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toBe('z\ny\nz\n');
    expect(result.content).toContain('Successfully replaced 2 occurrences');
  });

  test('returns ambiguity error when old_string appears multiple times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-file-edit-test-'));
    testDirs.push(dir);
    const filePath = join(dir, 'sample.txt');
    writeFileSync(filePath, 'repeat\nrepeat\n');

    const result = await hostFileEditTool.execute({
      path: filePath,
      old_string: 'repeat',
      new_string: 'new',
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('appears multiple times');
  });
});
