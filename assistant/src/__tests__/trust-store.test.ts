import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a temp directory for the trust file
const testDir = mkdtempSync(join(tmpdir(), 'trust-store-test-'));

// Mock platform module so trust-store writes to temp dir instead of ~/.vellum
mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

// Mock logger to suppress output during tests
mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import { addRule, removeRule, findMatchingRule, findDenyRule, getAllRules, clearCache } from '../permissions/trust-store.js';

describe('Trust Store', () => {
  beforeEach(() => {
    // Clear cached rules and remove the trust file between tests
    clearCache();
    const trustPath = join(testDir, 'trust.json');
    try { rmSync(trustPath); } catch { /* may not exist */ }
  });

  // Intentionally do not remove `testDir` in afterAll.
  // A late async log flush can still attempt to open `test.log` under this dir,
  // which intermittently causes an unhandled ENOENT in CI if the dir is removed.
  // ── addRule ─────────────────────────────────────────────────────

  describe('addRule', () => {
    test('adds a rule and returns it', () => {
      const rule = addRule('bash', 'git *', '/home/user/project');
      expect(rule.id).toBeDefined();
      expect(rule.tool).toBe('bash');
      expect(rule.pattern).toBe('git *');
      expect(rule.scope).toBe('/home/user/project');
      expect(rule.decision).toBe('allow');
      expect(rule.createdAt).toBeGreaterThan(0);
    });

    test('assigns unique IDs to each rule', () => {
      const rule1 = addRule('bash', 'npm *', '/tmp');
      const rule2 = addRule('bash', 'bun *', '/tmp');
      expect(rule1.id).not.toBe(rule2.id);
    });

    test('persists rule to disk', () => {
      addRule('bash', 'git push', '/home/user');
      const trustPath = join(testDir, 'trust.json');
      const raw = readFileSync(trustPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.version).toBe(1);
      expect(data.rules).toHaveLength(1);
      expect(data.rules[0].pattern).toBe('git push');
    });

    test('multiple rules accumulate', () => {
      addRule('bash', 'git *', '/tmp');
      addRule('file_write', '/tmp/*', '/tmp');
      addRule('bash', 'npm *', '/tmp');
      expect(getAllRules()).toHaveLength(3);
    });
  });

  // ── removeRule ──────────────────────────────────────────────────

  describe('removeRule', () => {
    test('removes an existing rule', () => {
      const rule = addRule('bash', 'git *', '/tmp');
      expect(removeRule(rule.id)).toBe(true);
      expect(getAllRules()).toHaveLength(0);
    });

    test('returns false for non-existent ID', () => {
      expect(removeRule('non-existent-id')).toBe(false);
    });

    test('persists removal to disk', () => {
      const rule = addRule('bash', 'npm *', '/tmp');
      removeRule(rule.id);
      // Reload from disk to verify
      clearCache();
      expect(getAllRules()).toHaveLength(0);
    });

    test('only removes the targeted rule', () => {
      const rule1 = addRule('bash', 'git *', '/tmp');
      const rule2 = addRule('bash', 'npm *', '/tmp');
      removeRule(rule1.id);
      const remaining = getAllRules();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(rule2.id);
    });
  });

  // ── findMatchingRule ────────────────────────────────────────────

  describe('findMatchingRule', () => {
    test('finds exact match', () => {
      addRule('bash', 'git push', '/tmp');
      const match = findMatchingRule('bash', 'git push', '/tmp');
      expect(match).not.toBeNull();
      expect(match!.pattern).toBe('git push');
    });

    test('finds glob wildcard match', () => {
      addRule('bash', 'git *', '/tmp');
      const match = findMatchingRule('bash', 'git push origin main', '/tmp');
      expect(match).not.toBeNull();
    });

    test('returns null when tool does not match', () => {
      addRule('file_write', 'git *', '/tmp');
      const match = findMatchingRule('bash', 'git push', '/tmp');
      expect(match).toBeNull();
    });

    test('returns null when pattern does not match', () => {
      addRule('bash', 'git *', '/tmp');
      const match = findMatchingRule('bash', 'npm install', '/tmp');
      expect(match).toBeNull();
    });

    // Scope matching
    describe('scope matching', () => {
      test('matches when scope equals rule scope', () => {
        addRule('bash', 'npm *', '/home/user/project');
        const match = findMatchingRule('bash', 'npm install', '/home/user/project');
        expect(match).not.toBeNull();
      });

      test('matches when scope is under rule scope (prefix)', () => {
        addRule('bash', 'npm *', '/home/user');
        const match = findMatchingRule('bash', 'npm install', '/home/user/project/sub');
        expect(match).not.toBeNull();
      });

      test('does not match when scope is outside rule scope', () => {
        addRule('bash', 'npm *', '/home/user/project');
        const match = findMatchingRule('bash', 'npm install', '/home/other');
        expect(match).toBeNull();
      });

      test('everywhere scope matches any directory', () => {
        addRule('bash', 'git *', 'everywhere');
        const match = findMatchingRule('bash', 'git status', '/any/random/path');
        expect(match).not.toBeNull();
      });

      test('everywhere scope matches root', () => {
        addRule('bash', 'ls', 'everywhere');
        const match = findMatchingRule('bash', 'ls', '/');
        expect(match).not.toBeNull();
      });
    });

    // Pattern matching with minimatch
    describe('pattern matching', () => {
      test('matches * wildcard', () => {
        addRule('bash', 'npm *', '/tmp');
        expect(findMatchingRule('bash', 'npm install', '/tmp')).not.toBeNull();
        expect(findMatchingRule('bash', 'npm test', '/tmp')).not.toBeNull();
      });

      test('matches exact string', () => {
        addRule('bash', 'git status', '/tmp');
        expect(findMatchingRule('bash', 'git status', '/tmp')).not.toBeNull();
        expect(findMatchingRule('bash', 'git push', '/tmp')).toBeNull();
      });

      test('matches file path pattern', () => {
        addRule('file_write', '/tmp/*', '/tmp');
        expect(findMatchingRule('file_write', '/tmp/file.txt', '/tmp')).not.toBeNull();
      });

      test('star pattern matches single-segment strings', () => {
        addRule('file_write', '*', '/tmp');
        // minimatch '*' matches strings without path separators
        expect(findMatchingRule('file_write', 'file.txt', '/tmp')).not.toBeNull();
      });

      test('star pattern does not match paths with slashes', () => {
        addRule('file_write', '*', '/tmp');
        // minimatch '*' does not cross '/' boundaries
        expect(findMatchingRule('file_write', '/any/path/file.txt', '/tmp')).toBeNull();
      });
    });
  });

  // ── getAllRules ─────────────────────────────────────────────────

  describe('getAllRules', () => {
    test('returns empty array when no rules exist', () => {
      expect(getAllRules()).toEqual([]);
    });

    test('returns a copy (not the internal array)', () => {
      addRule('bash', 'git *', '/tmp');
      const rules1 = getAllRules();
      const rules2 = getAllRules();
      expect(rules1).toEqual(rules2);
      expect(rules1).not.toBe(rules2); // different references
    });
  });

  // ── clearCache ─────────────────────────────────────────────────

  describe('clearCache', () => {
    test('forces reload from disk on next access', () => {
      addRule('bash', 'git *', '/tmp');
      expect(getAllRules()).toHaveLength(1);
      clearCache();
      // After clearing cache, rules are reloaded from disk
      expect(getAllRules()).toHaveLength(1);
    });
  });

  // ── persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    test('rules survive cache clear (loaded from disk)', () => {
      const rule = addRule('bash', 'npm *', '/tmp');
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe(rule.id);
    });

    test('trust file has correct structure', () => {
      addRule('bash', 'git *', '/tmp');
      const trustPath = join(testDir, 'trust.json');
      const data = JSON.parse(readFileSync(trustPath, 'utf-8'));
      expect(data).toHaveProperty('version', 1);
      expect(data).toHaveProperty('rules');
      expect(Array.isArray(data.rules)).toBe(true);
    });
  });

  // ── deny rules ─────────────────────────────────────────────────

  describe('deny rules', () => {
    test('addRule with deny decision creates a deny rule', () => {
      const rule = addRule('bash', 'rm -rf *', '/tmp', 'deny');
      expect(rule.decision).toBe('deny');
      expect(rule.tool).toBe('bash');
      expect(rule.pattern).toBe('rm -rf *');
    });

    test('deny rule persists to disk', () => {
      addRule('bash', 'rm *', '/tmp', 'deny');
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].decision).toBe('deny');
    });

    test('findDenyRule finds deny rules', () => {
      addRule('bash', 'rm *', '/tmp', 'deny');
      const match = findDenyRule('bash', 'rm file.txt', '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('deny');
    });

    test('findDenyRule ignores allow rules', () => {
      addRule('bash', 'rm *', '/tmp', 'allow');
      const match = findDenyRule('bash', 'rm file.txt', '/tmp');
      expect(match).toBeNull();
    });

    test('findMatchingRule ignores deny rules', () => {
      addRule('bash', 'rm *', '/tmp', 'deny');
      const match = findMatchingRule('bash', 'rm file.txt', '/tmp');
      expect(match).toBeNull();
    });

    test('deny and allow rules coexist', () => {
      addRule('bash', 'git *', '/tmp', 'allow');
      addRule('bash', 'git push --force *', '/tmp', 'deny');
      expect(findMatchingRule('bash', 'git status', '/tmp')).not.toBeNull();
      expect(findDenyRule('bash', 'git push --force origin', '/tmp')).not.toBeNull();
    });

    test('deny rule with scope matching', () => {
      addRule('bash', 'rm *', '/home/user/project', 'deny');
      expect(findDenyRule('bash', 'rm file.txt', '/home/user/project/sub')).not.toBeNull();
      expect(findDenyRule('bash', 'rm file.txt', '/home/other')).toBeNull();
    });

    test('deny rule with everywhere scope', () => {
      addRule('bash', 'rm -rf *', 'everywhere', 'deny');
      expect(findDenyRule('bash', 'rm -rf /', '/any/path')).not.toBeNull();
    });

    test('removeRule works for deny rules', () => {
      const rule = addRule('bash', 'rm *', '/tmp', 'deny');
      expect(removeRule(rule.id)).toBe(true);
      expect(findDenyRule('bash', 'rm file.txt', '/tmp')).toBeNull();
    });
  });
});
