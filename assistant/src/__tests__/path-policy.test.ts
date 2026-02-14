import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sandboxPathPolicy, hostPathPolicy } from '../tools/shared/filesystem/path-policy.js';

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'path-policy-'));

  // Create structure:
  //   root/
  //     sandbox/
  //       allowed.txt
  //       subdir/
  //         nested.txt
  //       link-escape -> /tmp (symlink pointing outside sandbox)
  //       link-ok -> subdir (symlink staying inside sandbox)
  //     outside/
  //       secret.txt

  mkdirSync(join(root, 'sandbox', 'subdir'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'sandbox', 'allowed.txt'), 'ok');
  writeFileSync(join(root, 'sandbox', 'subdir', 'nested.txt'), 'ok');
  writeFileSync(join(root, 'outside', 'secret.txt'), 'secret');
  symlinkSync(join(root, 'outside'), join(root, 'sandbox', 'link-escape'));
  symlinkSync(join(root, 'sandbox', 'subdir'), join(root, 'sandbox', 'link-ok'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// sandboxPathPolicy
// ---------------------------------------------------------------------------

describe('sandboxPathPolicy', () => {
  describe('traversal rejection', () => {
    it('rejects ../.. escape from sandbox', () => {
      const result = sandboxPathPolicy('../../etc/passwd', join(root, 'sandbox'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('outside the working directory');
      }
    });

    it('rejects ../ at the start', () => {
      const result = sandboxPathPolicy('../outside/secret.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(false);
    });

    it('rejects deeply nested traversal', () => {
      const result = sandboxPathPolicy('subdir/../../outside/secret.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(false);
    });
  });

  describe('symlink escape rejection', () => {
    it('rejects symlink that points outside the sandbox', () => {
      const result = sandboxPathPolicy('link-escape/secret.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('outside the working directory');
      }
    });

    it('allows symlink that stays inside the sandbox', () => {
      const result = sandboxPathPolicy('link-ok/nested.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(true);
    });
  });

  describe('mustExist: false (write-to-new-file)', () => {
    it('rejects parent symlink escape for new files', () => {
      // link-escape -> outside/, so link-escape/new.txt should fail
      const result = sandboxPathPolicy('link-escape/new.txt', join(root, 'sandbox'), { mustExist: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('outside the working directory');
      }
    });

    it('allows writing a new file under an existing safe directory', () => {
      const result = sandboxPathPolicy('subdir/newfile.txt', join(root, 'sandbox'), { mustExist: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toBe(join(root, 'sandbox', 'subdir', 'newfile.txt'));
      }
    });

    it('allows writing a new file in a not-yet-existing subdirectory', () => {
      const result = sandboxPathPolicy('newdir/newfile.txt', join(root, 'sandbox'), { mustExist: false });
      expect(result.ok).toBe(true);
    });
  });

  describe('valid paths', () => {
    it('allows a file directly in the sandbox', () => {
      const result = sandboxPathPolicy('allowed.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toBe(join(root, 'sandbox', 'allowed.txt'));
      }
    });

    it('allows a nested file', () => {
      const result = sandboxPathPolicy('subdir/nested.txt', join(root, 'sandbox'));
      expect(result.ok).toBe(true);
    });

    it('allows absolute path within sandbox', () => {
      const absPath = join(root, 'sandbox', 'allowed.txt');
      const result = sandboxPathPolicy(absPath, join(root, 'sandbox'));
      expect(result.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// hostPathPolicy
// ---------------------------------------------------------------------------

describe('hostPathPolicy', () => {
  it('rejects relative paths', () => {
    const result = hostPathPolicy('relative/path.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must be absolute');
      expect(result.error).toContain('relative/path.txt');
    }
  });

  it('rejects bare filenames', () => {
    const result = hostPathPolicy('file.txt');
    expect(result.ok).toBe(false);
  });

  it('accepts absolute paths', () => {
    const result = hostPathPolicy('/usr/local/bin/node');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/usr/local/bin/node');
    }
  });

  it('accepts root path', () => {
    const result = hostPathPolicy('/');
    expect(result.ok).toBe(true);
  });
});
