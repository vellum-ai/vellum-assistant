import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Create a temp directory for the trust file
const testDir = mkdtempSync(join(tmpdir(), 'trust-store-test-'));

// Mock platform module so trust-store writes to temp dir instead of ~/.vellum
mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
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

import { addRule, removeRule, updateRule, findMatchingRule, findDenyRule, findHighestPriorityRule, getAllRules, clearAllRules, clearCache } from '../permissions/trust-store.js';
import { getDefaultRuleTemplates } from '../permissions/defaults.js';

const trustPath = join(testDir, 'protected', 'trust.json');
const DEFAULT_TEMPLATES = getDefaultRuleTemplates();
const NUM_DEFAULTS = DEFAULT_TEMPLATES.length;
const DEFAULT_PRIORITY_BY_ID = new Map(DEFAULT_TEMPLATES.map((t) => [t.id, t.priority]));

describe('Trust Store', () => {
  beforeEach(() => {
    // Clear cached rules and remove the trust file between tests
    clearCache();
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
      expect(rule.priority).toBe(100);
      expect(rule.createdAt).toBeGreaterThan(0);
    });

    test('assigns unique IDs to each rule', () => {
      const rule1 = addRule('bash', 'npm *', '/tmp');
      const rule2 = addRule('bash', 'bun *', '/tmp');
      expect(rule1.id).not.toBe(rule2.id);
    });

    test('persists rule to disk', () => {
      addRule('bash', 'git push', '/home/user');
      const raw = readFileSync(trustPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.version).toBe(2);
      expect(data.rules).toHaveLength(1 + NUM_DEFAULTS);
      const userRule = data.rules.find((r: { pattern: string }) => r.pattern === 'git push');
      expect(userRule).toBeDefined();
      expect(userRule.priority).toBe(100);
    });

    test('multiple rules accumulate', () => {
      addRule('bash', 'git *', '/tmp');
      addRule('file_write', '/tmp/*', '/tmp');
      addRule('bash', 'npm *', '/tmp');
      expect(getAllRules()).toHaveLength(3 + NUM_DEFAULTS);
    });

    test('default priority is 100', () => {
      const rule = addRule('bash', 'git *', '/tmp');
      expect(rule.priority).toBe(100);
    });

    test('custom priority is respected', () => {
      const rule = addRule('bash', 'git *', '/tmp', 'allow', 5);
      expect(rule.priority).toBe(5);
    });

    test('rules are sorted by priority descending in getAllRules', () => {
      addRule('bash', 'low *', '/tmp', 'allow', 0);
      addRule('bash', 'high *', '/tmp', 'allow', 2);
      addRule('bash', 'med *', '/tmp', 'allow', 1);
      const rules = getAllRules();
      // Default ask rules have higher priority than user rules
      const maxDefaultPriority = Math.max(...DEFAULT_TEMPLATES.map((t) => t.priority));
      expect(rules[0].priority).toBe(maxDefaultPriority);
      const userRules = rules.filter((r) => !r.id.startsWith('default:'));
      expect(userRules[0].priority).toBe(2);
      expect(userRules[1].priority).toBe(1);
      expect(userRules[2].priority).toBe(0);
    });

    test('at same priority deny rules sort before allow rules', () => {
      addRule('bash', 'allow *', '/tmp', 'allow', 100);
      addRule('bash', 'deny *', '/tmp', 'deny', 100);
      const userRules = getAllRules().filter((r) => !r.id.startsWith('default:'));
      expect(userRules[0].decision).toBe('deny');
      expect(userRules[1].decision).toBe('allow');
    });
  });

  // ── removeRule ──────────────────────────────────────────────────

  describe('removeRule', () => {
    test('removes an existing rule', () => {
      const rule = addRule('bash', 'git *', '/tmp');
      expect(removeRule(rule.id)).toBe(true);
      expect(getAllRules()).toHaveLength(NUM_DEFAULTS);
    });

    test('returns false for non-existent ID', () => {
      expect(removeRule('non-existent-id')).toBe(false);
    });

    test('persists removal to disk', () => {
      const rule = addRule('bash', 'npm *', '/tmp');
      removeRule(rule.id);
      // Reload from disk to verify
      clearCache();
      expect(getAllRules()).toHaveLength(NUM_DEFAULTS);
    });

    test('only removes the targeted rule', () => {
      const rule1 = addRule('bash', 'git *', '/tmp');
      const rule2 = addRule('bash', 'npm *', '/tmp');
      removeRule(rule1.id);
      const remaining = getAllRules();
      expect(remaining).toHaveLength(1 + NUM_DEFAULTS);
      expect(remaining.find((r) => r.id === rule2.id)).toBeDefined();
    });
  });

  // ── updateRule ─────────────────────────────────────────────────

  describe('updateRule', () => {
    test('updates pattern on an existing rule', () => {
      const rule = addRule('bash', 'git *', '/tmp');
      const updated = updateRule(rule.id, { pattern: 'git push *' });
      expect(updated.pattern).toBe('git push *');
      expect(updated.id).toBe(rule.id);
      expect(updated.tool).toBe('bash');
    });

    test('updates multiple fields at once', () => {
      const rule = addRule('bash', 'npm *', '/tmp');
      const updated = updateRule(rule.id, { tool: 'file_write', scope: '/home', decision: 'deny', priority: 50 });
      expect(updated.tool).toBe('file_write');
      expect(updated.scope).toBe('/home');
      expect(updated.decision).toBe('deny');
      expect(updated.priority).toBe(50);
    });

    test('throws for non-existent rule ID', () => {
      expect(() => updateRule('non-existent-id', { pattern: 'test' })).toThrow('Trust rule not found: non-existent-id');
    });

    test('persists update to disk', () => {
      const rule = addRule('bash', 'git *', '/tmp');
      updateRule(rule.id, { pattern: 'git status' });
      clearCache();
      const rules = getAllRules();
      const found = rules.find((r) => r.id === rule.id);
      expect(found).toBeDefined();
      expect(found!.pattern).toBe('git status');
    });

    test('re-sorts rules after priority change', () => {
      const rule1 = addRule('bash', 'low *', '/tmp', 'allow', 10);
      const rule2 = addRule('bash', 'high *', '/tmp', 'allow', 200);
      // rule2 should be first (higher priority)
      let userRules = getAllRules().filter((r) => !r.id.startsWith('default:'));
      expect(userRules[0].id).toBe(rule2.id);
      // Update rule1 to have higher priority
      updateRule(rule1.id, { priority: 300 });
      userRules = getAllRules().filter((r) => !r.id.startsWith('default:'));
      expect(userRules[0].id).toBe(rule1.id);
    });

    test('leaves unchanged fields intact', () => {
      const rule = addRule('bash', 'git *', '/home/user', 'allow', 100);
      updateRule(rule.id, { pattern: 'git push *' });
      const updated = getAllRules().find((r) => r.id === rule.id)!;
      expect(updated.tool).toBe('bash');
      expect(updated.scope).toBe('/home/user');
      expect(updated.decision).toBe('allow');
      expect(updated.priority).toBe(100);
      expect(updated.createdAt).toBe(rule.createdAt);
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

  // ── findHighestPriorityRule ──────────────────────────────────────

  describe('findHighestPriorityRule', () => {
    test('returns highest priority matching rule', () => {
      addRule('bash', 'rm *', '/tmp', 'allow', 0);
      addRule('bash', 'rm *', '/tmp', 'deny', 100);
      const match = findHighestPriorityRule('bash', ['rm file.txt'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('deny');
      expect(match!.priority).toBe(100);
    });

    test('higher priority allow beats lower priority deny', () => {
      addRule('bash', 'rm *', '/tmp', 'deny', 0);
      addRule('bash', 'rm *', '/tmp', 'allow', 100);
      const match = findHighestPriorityRule('bash', ['rm file.txt'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('allow');
    });

    test('same priority: deny beats allow', () => {
      addRule('bash', 'rm *', '/tmp', 'allow', 100);
      addRule('bash', 'rm *', '/tmp', 'deny', 100);
      const match = findHighestPriorityRule('bash', ['rm file.txt'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('deny');
    });

    test('checks multiple command candidates', () => {
      addRule('web_fetch', 'web_fetch:https://example.com/*', '/tmp', 'allow');
      const match = findHighestPriorityRule(
        'web_fetch',
        ['web_fetch:https://example.com/page', 'web_fetch:https://example.com/*'],
        '/tmp',
      );
      expect(match).not.toBeNull();
    });

    test('returns null when no rule matches', () => {
      addRule('bash', 'git *', '/tmp', 'allow');
      const match = findHighestPriorityRule('bash', ['npm install'], '/tmp');
      expect(match).toBeNull();
    });

    test('respects scope matching', () => {
      addRule('bash', 'rm *', '/home/user/project', 'deny');
      expect(findHighestPriorityRule('bash', ['rm file.txt'], '/home/user/project/sub')).not.toBeNull();
      expect(findHighestPriorityRule('bash', ['rm file.txt'], '/home/other')).toBeNull();
    });

    test('everywhere scope matches any directory', () => {
      addRule('bash', 'git *', 'everywhere', 'allow');
      const match = findHighestPriorityRule('bash', ['git status'], '/any/random/path');
      expect(match).not.toBeNull();
    });
  });

  // ── getAllRules ─────────────────────────────────────────────────

  describe('getAllRules', () => {
    test('returns default rules when no user rules exist', () => {
      const rules = getAllRules();
      expect(rules).toHaveLength(NUM_DEFAULTS);
      expect(rules.every((r) => r.id.startsWith('default:'))).toBe(true);
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
      expect(getAllRules()).toHaveLength(1 + NUM_DEFAULTS);
      clearCache();
      // After clearing cache, rules are reloaded from disk
      expect(getAllRules()).toHaveLength(1 + NUM_DEFAULTS);
    });
  });

  // ── persistence ─────────────────────────────────────────────────

  describe('persistence', () => {
    test('rules survive cache clear (loaded from disk)', () => {
      const rule = addRule('bash', 'npm *', '/tmp');
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      expect(rules.find((r) => r.id === rule.id)).toBeDefined();
    });

    test('trust file has correct structure', () => {
      addRule('bash', 'git *', '/tmp');
      const data = JSON.parse(readFileSync(trustPath, 'utf-8'));
      expect(data).toHaveProperty('version', 2);
      expect(data).toHaveProperty('rules');
      expect(Array.isArray(data.rules)).toBe(true);
      const userRule = data.rules.find((r: { pattern: string }) => r.pattern === 'git *');
      expect(userRule).toHaveProperty('priority', 100);
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
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      const userRule = rules.find((r) => r.pattern === 'rm *');
      expect(userRule).toBeDefined();
      expect(userRule!.decision).toBe('deny');
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

  // ── v1 migration ───────────────────────────────────────────────

  describe('v1 migration', () => {
    test('v1 rules get priority 100 on load', () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, JSON.stringify({
        version: 1,
        rules: [{
          id: 'test-v1-id',
          tool: 'bash',
          pattern: 'git *',
          scope: '/tmp',
          decision: 'allow',
          createdAt: 1000,
        }],
      }));
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      const migratedRule = rules.find((r) => r.id === 'test-v1-id');
      expect(migratedRule).toBeDefined();
      expect(migratedRule!.priority).toBe(100);
    });

    test('v1 file is upgraded to v2 on disk', () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, JSON.stringify({
        version: 1,
        rules: [{
          id: 'migrate-me',
          tool: 'bash',
          pattern: 'npm *',
          scope: 'everywhere',
          decision: 'allow',
          createdAt: 2000,
        }],
      }));
      clearCache();
      getAllRules(); // triggers load + migration
      const data = JSON.parse(readFileSync(trustPath, 'utf-8'));
      expect(data.version).toBe(2);
      const migratedRule = data.rules.find((r: { id: string }) => r.id === 'migrate-me');
      expect(migratedRule.priority).toBe(100);
    });
  });

  // ── loadFromDisk resilience ─────────────────────────────────────

  describe('loadFromDisk resilience', () => {
    test('returns in-memory rules when saveToDisk fails during migration', () => {
      // Write a v1 trust file that triggers needsSave on load
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, JSON.stringify({
        version: 1,
        rules: [{
          id: 'v1-readonly',
          tool: 'bash',
          pattern: 'git *',
          scope: '/tmp',
          decision: 'allow' as const,
          createdAt: 1000,
        }],
      }));

      // Spy on writeFileSync to throw when saveToDisk is called during migration.
      // This is deterministic regardless of user privileges (unlike chmod 0o555).
      const spy = spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('Simulated write failure');
      });

      try {
        clearCache();
        const rules = getAllRules();
        // Should still return the migrated rules + defaults in-memory
        expect(rules).toHaveLength(1 + NUM_DEFAULTS);
        const migratedRule = rules.find((r) => r.id === 'v1-readonly');
        expect(migratedRule).toBeDefined();
        expect(migratedRule!.priority).toBe(100);
        // Verify that saveToDisk was attempted (writeFileSync was called)
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── default rules ─────────────────────────────────────────────

  describe('default rules', () => {
    test('backfills default ask rules for protected directory on first load', () => {
      const rules = getAllRules();
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
      for (const rule of defaults) {
        expect(rule.decision).toBe('ask');
        expect(rule.priority).toBe(DEFAULT_PRIORITY_BY_ID.get(rule.id)!);
        expect(rule.scope).toBe('everywhere');
      }

      const protectedDefaults = defaults.filter((rule) => rule.id.endsWith('-protected'));
      expect(protectedDefaults).toHaveLength(3);
      for (const rule of protectedDefaults) {
        expect(rule.pattern).toContain(`${testDir}/protected/`);
      }
    });

    test('default rules cover file, host file, and host shell tools', () => {
      const rules = getAllRules();
      const defaultTools = rules
        .filter((r) => r.id.startsWith('default:'))
        .map((r) => r.tool)
        .sort();
      expect(defaultTools).toEqual([
        'cu_click',
        'cu_double_click',
        'cu_drag',
        'cu_key',
        'cu_open_app',
        'cu_right_click',
        'cu_run_applescript',
        'cu_scroll',
        'cu_type_text',
        'cu_wait',
        'delete_managed_skill',
        'file_edit',
        'file_read',
        'file_write',
        'host_bash',
        'host_file_edit',
        'host_file_read',
        'host_file_write',
        'request_computer_control',
        'scaffold_managed_skill',
      ]);
    });

    test('default rules are not duplicated on reload', () => {
      getAllRules(); // first load
      clearCache();
      const rules = getAllRules(); // second load
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test('default rules persist to disk', () => {
      getAllRules(); // triggers backfill + save
      const data = JSON.parse(readFileSync(trustPath, 'utf-8'));
      const defaults = data.rules.filter((r: { id: string }) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test('default rules are backfilled alongside v1 migration', () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, JSON.stringify({
        version: 1,
        rules: [{
          id: 'v1-user-rule',
          tool: 'bash',
          pattern: 'git *',
          scope: '/tmp',
          decision: 'allow',
          createdAt: 1000,
        }],
      }));
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      expect(rules.find((r) => r.id === 'v1-user-rule')!.priority).toBe(100);
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
      expect(defaults.every((r) => r.priority === DEFAULT_PRIORITY_BY_ID.get(r.id))).toBe(true);
    });

    test('removed default rule is re-backfilled on next load', () => {
      // First load backfills defaults
      getAllRules();
      // Remove one default rule by editing trust.json directly on disk
      // (removeRule() throws for default rules, so we simulate external editing)
      const raw = JSON.parse(readFileSync(trustPath, 'utf-8'));
      raw.rules = raw.rules.filter((r: { id: string }) => r.id !== 'default:ask-file_read-protected');
      writeFileSync(trustPath, JSON.stringify(raw, null, 2));
      // After reload, the rule is re-backfilled (defaults are always present)
      clearCache();
      const rules = getAllRules();
      expect(rules.find((r) => r.id === 'default:ask-file_read-protected')).toBeDefined();
    });

    test('findHighestPriorityRule matches default ask for protected file_read', () => {
      const protectedPath = join(testDir, 'protected', 'trust.json');
      const match = findHighestPriorityRule('file_read', [`file_read:${protectedPath}`], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-file_read-protected')!);
    });

    test('findHighestPriorityRule matches default ask for protected file_write', () => {
      const protectedPath = join(testDir, 'protected', 'keys.enc');
      const match = findHighestPriorityRule('file_write', [`file_write:${protectedPath}`], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('ask');
    });

    test('findHighestPriorityRule matches default ask for protected file_edit', () => {
      const protectedPath = join(testDir, 'protected', 'secret-allowlist.json');
      const match = findHighestPriorityRule('file_edit', [`file_edit:${protectedPath}`], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.decision).toBe('ask');
    });

    test('findHighestPriorityRule matches default ask for host_file_read', () => {
      const match = findHighestPriorityRule('host_file_read', ['host_file_read:/etc/hosts'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-host_file_read-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-host_file_read-global')!);
    });

    test('findHighestPriorityRule matches default ask for host_file_write', () => {
      const match = findHighestPriorityRule('host_file_write', ['host_file_write:/etc/hosts'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-host_file_write-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-host_file_write-global')!);
    });

    test('findHighestPriorityRule matches default ask for host_file_edit', () => {
      const match = findHighestPriorityRule('host_file_edit', ['host_file_edit:/etc/hosts'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-host_file_edit-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-host_file_edit-global')!);
    });

    test('findHighestPriorityRule matches default ask for host_bash', () => {
      const match = findHighestPriorityRule('host_bash', ['ls'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-host_bash-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-host_bash-global')!);
    });

    test('findHighestPriorityRule matches default ask for cu_click', () => {
      const match = findHighestPriorityRule('cu_click', ['cu_click:'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-cu_click-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-cu_click-global')!);
    });

    test('findHighestPriorityRule matches default ask for request_computer_control', () => {
      const match = findHighestPriorityRule('request_computer_control', ['request_computer_control:'], '/tmp');
      expect(match).not.toBeNull();
      expect(match!.id).toBe('default:ask-request_computer_control-global');
      expect(match!.decision).toBe('ask');
      expect(match!.priority).toBe(DEFAULT_PRIORITY_BY_ID.get('default:ask-request_computer_control-global')!);
    });

    test('default ask does not affect files outside protected directory', () => {
      const safePath = join(testDir, 'data', 'assistant.db');
      const match = findHighestPriorityRule('file_read', [`file_read:${safePath}`], '/tmp');
      // Should not match a default deny rule
      expect(match === null || !match.id.startsWith('default:')).toBe(true);
    });

    test('default rules are backfilled after malformed JSON in trust file', () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, 'NOT VALID JSON {{{');
      clearCache();
      const rules = getAllRules();
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test('default rules are backfilled in-memory after unknown file version without overwriting disk', () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      const originalContent = JSON.stringify({ version: 9999, rules: [{ id: 'future-rule', tool: 'bash', pattern: 'future *', scope: 'everywhere', decision: 'allow', priority: 50, createdAt: 1000 }] });
      writeFileSync(trustPath, originalContent);
      clearCache();
      const rules = getAllRules();
      // Defaults should be present in-memory
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
      // The on-disk file must NOT be overwritten — it preserves the unknown format
      const diskContent = readFileSync(trustPath, 'utf-8');
      expect(diskContent).toBe(originalContent);
    });

    test('clearAllRules preserves default rules', () => {
      addRule('bash', 'git *', '/tmp');
      clearAllRules();
      const rules = getAllRules();
      // User rules should be gone, but defaults should remain
      expect(rules.filter((r) => !r.id.startsWith('default:'))).toHaveLength(0);
      const defaults = rules.filter((r) => r.id.startsWith('default:'));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });
  });
});
