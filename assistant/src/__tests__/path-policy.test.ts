import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sandboxPolicy, hostPolicy } from '../tools/shared/filesystem/path-policy.js';

// ---------------------------------------------------------------------------
// Shared temp sandbox for sandbox policy tests
// ---------------------------------------------------------------------------

let sandbox: string;
let realSandbox: string;

beforeAll(() => {
  // macOS /tmp is a symlink to /private/tmp — resolve it for assertions
  sandbox = mkdtempSync(join(tmpdir(), 'path-policy-'));
  const { realpathSync } = require('node:fs');
  realSandbox = realpathSync(sandbox);

  // Create a file and subdirectory inside the sandbox
  mkdirSync(join(sandbox, 'sub'));
  writeFileSync(join(sandbox, 'sub', 'file.txt'), 'hello');

  // Symlink inside sandbox that points outside
  symlinkSync('/tmp', join(sandbox, 'escape-link'));

  // Symlink directory inside sandbox that points outside
  mkdirSync(join(sandbox, 'parent-escape'));
  symlinkSync('/tmp', join(sandbox, 'parent-escape', 'link-dir'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

describe('sandboxPolicy', () => {
  it('accepts a relative path within the sandbox', () => {
    const result = sandboxPolicy('sub/file.txt', sandbox);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(sandbox, 'sub', 'file.txt'));
    }
  });

  it('rejects traversal via ../..', () => {
    const result = sandboxPolicy('../../etc/passwd', sandbox);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_OUT_OF_BOUNDS');
      expect(result.error.path).toBe('../../etc/passwd');
    }
  });

  it('rejects traversal via sub/../../..', () => {
    const result = sandboxPolicy('sub/../../..', sandbox);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_OUT_OF_BOUNDS');
    }
  });

  it('rejects symlink escape (symlink pointing outside boundary)', () => {
    const result = sandboxPolicy('escape-link/somefile', sandbox);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_OUT_OF_BOUNDS');
    }
  });

  it('rejects symlink escape with mustExist: false (parent symlink)', () => {
    // parent-escape/link-dir is a symlink to /tmp, so writing
    // parent-escape/link-dir/new-file.txt should be caught
    const result = sandboxPolicy(
      'parent-escape/link-dir/new-file.txt',
      sandbox,
      { mustExist: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_OUT_OF_BOUNDS');
    }
  });

  it('accepts a new file path within the sandbox (mustExist: false)', () => {
    const result = sandboxPolicy('sub/new-file.txt', sandbox, { mustExist: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(sandbox, 'sub', 'new-file.txt'));
    }
  });

  it('accepts the sandbox root itself', () => {
    const result = sandboxPolicy('.', sandbox);
    expect(result.ok).toBe(true);
  });

  it('error message includes the boundary path', () => {
    const result = sandboxPolicy('../..', sandbox);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(realSandbox);
    }
  });
});

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

describe('hostPolicy', () => {
  it('rejects a relative path', () => {
    const result = hostPolicy('relative/path.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_NOT_ABSOLUTE');
      expect(result.error.path).toBe('relative/path.txt');
    }
  });

  it('rejects a bare filename', () => {
    const result = hostPolicy('file.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PATH_NOT_ABSOLUTE');
    }
  });

  it('accepts an absolute path', () => {
    const result = hostPolicy('/usr/local/bin/thing');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/usr/local/bin/thing');
    }
  });

  it('accepts root path', () => {
    const result = hostPolicy('/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/');
    }
  });
});
