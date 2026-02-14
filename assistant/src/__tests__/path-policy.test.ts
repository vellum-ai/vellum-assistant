import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandboxPolicy, hostPolicy } from '../tools/shared/filesystem/path-policy.js';

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'path-policy-test-')));
  testDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

describe('sandboxPolicy', () => {
  test('rejects traversal escape via ../', () => {
    const boundary = makeTempDir();
    const result = sandboxPolicy('../../etc/passwd', boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside the working directory');
    }
  });

  test('rejects deep traversal escape', () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, 'a', 'b'), { recursive: true });
    const result = sandboxPolicy('a/b/../../../../etc/shadow', boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside the working directory');
    }
  });

  test('rejects symlink that escapes the boundary', () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();

    // Create a symlink inside the boundary that points outside
    symlinkSync(outside, join(boundary, 'escape-link'));

    const result = sandboxPolicy('escape-link', boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside the working directory');
    }
  });

  test('rejects parent dir symlink escape in mustExist=false flow', () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();

    // Create a symlink directory inside boundary pointing outside
    symlinkSync(outside, join(boundary, 'link-dir'));

    // Writing a new file under link-dir should be caught
    const result = sandboxPolicy('link-dir/new-file.txt', boundary, { mustExist: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('outside the working directory');
    }
  });

  test('accepts valid relative path within boundary', () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, 'sub'));

    const result = sandboxPolicy('sub/file.txt', boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(boundary, 'sub', 'file.txt'));
    }
  });

  test('accepts absolute path within boundary', () => {
    const boundary = makeTempDir();
    const filePath = join(boundary, 'file.txt');

    const result = sandboxPolicy(filePath, boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(filePath);
    }
  });

  test('accepts new file path with mustExist=false', () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, 'subdir'));

    const result = sandboxPolicy('subdir/new-file.txt', boundary, { mustExist: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(boundary, 'subdir', 'new-file.txt'));
    }
  });
});

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

describe('hostPolicy', () => {
  test('rejects relative path', () => {
    const result = hostPolicy('relative/path.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be absolute');
      expect(result.error).toContain('relative/path.txt');
    }
  });

  test('rejects bare filename', () => {
    const result = hostPolicy('file.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be absolute');
    }
  });

  test('accepts absolute path', () => {
    const result = hostPolicy('/usr/local/bin/something');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/usr/local/bin/something');
    }
  });

  test('accepts root path', () => {
    const result = hostPolicy('/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/');
    }
  });
});
