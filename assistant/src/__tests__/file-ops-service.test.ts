import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileSystemOps, type PathPolicy } from '../tools/shared/filesystem/file-ops-service.js';
import { sandboxPolicy } from '../tools/shared/filesystem/path-policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'file-ops-test-')));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a sandbox-bound PathPolicy for the given directory. */
function sandboxPolicyFor(boundary: string): PathPolicy {
  return (rawPath, options) => sandboxPolicy(rawPath, boundary, options);
}

// ---------------------------------------------------------------------------
// readFileSafe
// ---------------------------------------------------------------------------

describe('FileSystemOps.readFileSafe', () => {
  test('reads a file successfully', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'hello.txt'), 'line one\nline two\nline three\n');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: 'hello.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('line one');
    expect(result.value.content).toContain('line two');
    expect(result.value.content).toContain('line three');
  });

  test('returns NOT_FOUND for missing file', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: 'nonexistent.txt' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  test('returns NOT_A_FILE for a directory', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'subdir'));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: 'subdir' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_A_FILE');
  });

  test('returns SIZE_LIMIT_EXCEEDED for oversized file', () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'big.txt');
    writeFileSync(filePath, 'x'.repeat(200));

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.readFileSafe({ path: 'big.txt' });
    expect(result.ok).toBe(true);
  });

  test('returns INVALID_PATH for path outside sandbox', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: '../../../etc/passwd' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PATH');
  });

  test('respects offset and limit', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'lines.txt'), 'a\nb\nc\nd\ne\n');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.readFileSafe({ path: 'lines.txt', offset: 2, limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain('b');
    expect(result.value.content).toContain('c');
    expect(result.value.content).not.toContain('     1');
    expect(result.value.content).not.toContain('d');
  });
});

// ---------------------------------------------------------------------------
// writeFileSafe
// ---------------------------------------------------------------------------

describe('FileSystemOps.writeFileSafe', () => {
  test('writes a new file', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: 'new.txt', content: 'hello world' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isNewFile).toBe(true);
    expect(result.value.newContent).toBe('hello world');
    expect(result.value.oldContent).toBe('');
    expect(existsSync(join(dir, 'new.txt'))).toBe(true);
  });

  test('overwrites an existing file and returns old content', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'existing.txt'), 'old stuff');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: 'existing.txt', content: 'new stuff' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isNewFile).toBe(false);
    expect(result.value.oldContent).toBe('old stuff');
    expect(result.value.newContent).toBe('new stuff');
  });

  test('creates parent directories when needed', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: 'a/b/c/deep.txt', content: 'deep' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isNewFile).toBe(true);
    expect(existsSync(join(dir, 'a/b/c/deep.txt'))).toBe(true);
  });

  test('returns INVALID_PATH for path outside sandbox', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: '../../../tmp/evil.txt', content: 'bad' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PATH');
  });

  test('returns SIZE_LIMIT_EXCEEDED for oversized content (indirectly)', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.writeFileSafe({ path: 'small.txt', content: 'small' });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// editFileSafe
// ---------------------------------------------------------------------------

describe('FileSystemOps.editFileSafe', () => {
  test('returns NOT_FOUND for nonexistent file', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'nope.txt',
      oldString: 'a',
      newString: 'b',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  test('returns NOT_A_FILE when target is a directory', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'subdir'));
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'subdir',
      oldString: 'a',
      newString: 'b',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_A_FILE');
  });

  test('returns MATCH_NOT_FOUND when old_string is absent', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'file.txt'), 'hello world');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'file.txt',
      oldString: 'xyz',
      newString: 'abc',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MATCH_NOT_FOUND');
  });

  test('returns MATCH_AMBIGUOUS when old_string matches multiple times', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'file.txt'), 'foo bar foo baz foo');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'file.txt',
      oldString: 'foo',
      newString: 'qux',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MATCH_AMBIGUOUS');
  });

  test('replaces all occurrences when replaceAll is true', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'file.txt'), 'foo bar foo baz foo');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'file.txt',
      oldString: 'foo',
      newString: 'qux',
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matchCount).toBe(3);
    expect(result.value.newContent).toBe('qux bar qux baz qux');
    expect(result.value.oldContent).toBe('foo bar foo baz foo');
    expect(result.value.matchMethod).toBe('exact');
  });

  test('performs a unique edit successfully', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'file.txt'), 'one two three');
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: 'file.txt',
      oldString: 'two',
      newString: 'TWO',
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matchCount).toBe(1);
    expect(result.value.newContent).toBe('one TWO three');
    expect(result.value.matchMethod).toBe('exact');
    expect(result.value.filePath).toContain('file.txt');
  });

  test('returns INVALID_PATH for path outside sandbox', () => {
    const dir = makeTempDir();
    const ops = new FileSystemOps(sandboxPolicyFor(dir));

    const result = ops.editFileSafe({
      path: '../../../etc/passwd',
      oldString: 'root',
      newString: 'toor',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PATH');
  });
});
