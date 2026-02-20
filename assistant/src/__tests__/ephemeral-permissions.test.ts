import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use a temp directory so trust-store doesn't touch ~/.vellum
const testDir = mkdtempSync(join(tmpdir(), 'ephemeral-perm-test-'));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => join(testDir, 'data'),
  getWorkspaceSkillsDir: () => join(testDir, 'skills'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const testConfig: Record<string, any> = {
  permissions: { mode: 'legacy' as 'legacy' | 'strict' },
  skills: { load: { extraDirs: [] as string[] } },
  sandbox: { enabled: false },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

import { setTaskRunRules, getTaskRunRules, clearTaskRunRules, buildTaskRules } from '../tasks/ephemeral-permissions.js';
import { findHighestPriorityRule, addRule, clearCache } from '../permissions/trust-store.js';
import { check, classifyRisk } from '../permissions/checker.js';
import type { TrustRule, PolicyContext } from '../permissions/types.js';

// Ensure the protected directory exists for trust-store disk operations
mkdirSync(join(testDir, 'protected'), { recursive: true });

describe('ephemeral-permissions', () => {
  // Warm up the shell parser (loads WASM) — required before any check() call
  // that involves bash commands, otherwise the parser init may hang.
  beforeAll(async () => {
    await classifyRisk('bash', { command: 'echo warmup' });
  });
  describe('buildTaskRules', () => {
    test('generates correct rule structure for each required tool', () => {
      const taskRunId = 'run-123';
      const requiredTools = ['file_read', 'bash', 'file_write'];
      const workingDir = '/home/user/project';

      const rules = buildTaskRules(taskRunId, requiredTools, workingDir);

      expect(rules).toHaveLength(3);

      // Check the first rule in detail
      const fileReadRule = rules[0];
      expect(fileReadRule.id).toBe('ephemeral:run-123:file_read');
      expect(fileReadRule.tool).toBe('file_read');
      expect(fileReadRule.pattern).toBe('**');
      expect(fileReadRule.scope).toBe('everywhere');
      expect(fileReadRule.decision).toBe('allow');
      expect(fileReadRule.priority).toBe(75);
      expect(fileReadRule.principalKind).toBe('task');
      expect(fileReadRule.principalId).toBe('run-123');
      expect(fileReadRule.createdAt).toBeGreaterThan(0);

      // Task-run rules are pre-approved and must allow high-risk tools.
      expect(fileReadRule.allowHighRisk).toBe(true);

      // Check other rules have correct tool names
      expect(rules[1].tool).toBe('bash');
      expect(rules[1].id).toBe('ephemeral:run-123:bash');
      expect(rules[2].tool).toBe('file_write');
      expect(rules[2].id).toBe('ephemeral:run-123:file_write');
    });

    test('returns empty array for empty required tools', () => {
      const rules = buildTaskRules('run-456', [], '/tmp');
      expect(rules).toHaveLength(0);
    });
  });

  describe('setTaskRunRules / getTaskRunRules / clearTaskRunRules', () => {
    beforeEach(() => {
      // Clean up any leftover state
      clearTaskRunRules('test-run-1');
      clearTaskRunRules('test-run-2');
    });

    test('returns empty array for unknown task run', () => {
      expect(getTaskRunRules('nonexistent')).toEqual([]);
    });

    test('stores and retrieves rules for a task run', () => {
      const rules = buildTaskRules('test-run-1', ['file_read'], '/tmp');
      setTaskRunRules('test-run-1', rules);

      const retrieved = getTaskRunRules('test-run-1');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].tool).toBe('file_read');
    });

    test('clears rules for a task run', () => {
      const rules = buildTaskRules('test-run-1', ['file_read'], '/tmp');
      setTaskRunRules('test-run-1', rules);
      expect(getTaskRunRules('test-run-1')).toHaveLength(1);

      clearTaskRunRules('test-run-1');
      expect(getTaskRunRules('test-run-1')).toEqual([]);
    });

    test('isolates rules between task runs', () => {
      const rules1 = buildTaskRules('test-run-1', ['file_read'], '/tmp');
      const rules2 = buildTaskRules('test-run-2', ['bash', 'file_write'], '/home');

      setTaskRunRules('test-run-1', rules1);
      setTaskRunRules('test-run-2', rules2);

      expect(getTaskRunRules('test-run-1')).toHaveLength(1);
      expect(getTaskRunRules('test-run-2')).toHaveLength(2);

      clearTaskRunRules('test-run-1');
      expect(getTaskRunRules('test-run-1')).toEqual([]);
      expect(getTaskRunRules('test-run-2')).toHaveLength(2);
    });
  });

  describe('findHighestPriorityRule with ephemeral rules', () => {
    beforeEach(() => {
      clearCache();
    });

    test('ephemeral rules are found by findHighestPriorityRule', () => {
      const ephemeralRules: TrustRule[] = [{
        id: 'ephemeral:run-1:file_read',
        tool: 'file_read',
        pattern: '**',
        scope: '/home/user/project',
        decision: 'allow',
        priority: 50,
        createdAt: Date.now(),
        principalKind: 'task',
        principalId: 'run-1',
      }];

      const ctx: PolicyContext = {
        principal: { kind: 'task', id: 'run-1' },
        ephemeralRules,
        // Treat this check as host-targeted so workspace_full_access mode
        // from other tests cannot auto-allow before risk evaluation.
        executionTarget: 'host',
      };

      const result = findHighestPriorityRule(
        'file_read',
        ['file_read:/home/user/project/foo.txt'],
        '/home/user/project',
        ctx,
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe('ephemeral:run-1:file_read');
      expect(result!.decision).toBe('allow');
    });

    test('user deny rules at higher priority override ephemeral allow rules', () => {
      // Add a persistent user deny rule with priority 100
      addRule('file_read', '**', '/home/user/project', 'deny', 100);

      const ephemeralRules: TrustRule[] = [{
        id: 'ephemeral:run-1:file_read',
        tool: 'file_read',
        pattern: '**',
        scope: '/home/user/project',
        decision: 'allow',
        priority: 50,
        createdAt: Date.now(),
        principalKind: 'task',
        principalId: 'run-1',
      }];

      const ctx: PolicyContext = {
        principal: { kind: 'task', id: 'run-1' },
        ephemeralRules,
      };

      const result = findHighestPriorityRule(
        'file_read',
        ['file_read:/home/user/project/foo.txt'],
        '/home/user/project',
        ctx,
      );

      expect(result).not.toBeNull();
      // The user deny rule (priority 100) should win over the ephemeral allow (priority 50)
      expect(result!.decision).toBe('deny');
    });

    test('ephemeral rules do not match when scope is outside working dir', () => {
      const ephemeralRules: TrustRule[] = [{
        id: 'ephemeral:run-1:file_read',
        tool: 'file_read',
        pattern: '**',
        scope: '/home/user/project',
        decision: 'allow',
        priority: 50,
        createdAt: Date.now(),
        principalKind: 'task',
        principalId: 'run-1',
      }];

      const ctx: PolicyContext = {
        principal: { kind: 'task', id: 'run-1' },
        ephemeralRules,
      };

      // Query with a different scope that doesn't match the ephemeral rule's scope
      const result = findHighestPriorityRule(
        'file_read',
        ['file_read:/other/path/foo.txt'],
        '/other/path',
        ctx,
      );

      // Should not match the ephemeral rule (scope mismatch)
      // May or may not match a default rule
      if (result) {
        expect(result.id).not.toBe('ephemeral:run-1:file_read');
      }
    });
  });

  describe('check() with ephemeral rules', () => {
    beforeEach(() => {
      clearCache();
      testConfig.permissions.mode = 'legacy';
    });

    test('ephemeral allow rule auto-allows non-high-risk tool', async () => {
      const ephemeralRules: TrustRule[] = [{
        id: 'ephemeral:run-1:file_read',
        tool: 'file_read',
        pattern: '**',
        scope: 'everywhere',
        decision: 'allow',
        priority: 50,
        createdAt: Date.now(),
        principalKind: 'task',
        principalId: 'run-1',
      }];

      const ctx: PolicyContext = {
        principal: { kind: 'task', id: 'run-1' },
        ephemeralRules,
      };

      // Use testDir (a real temp path) to avoid EPERM on macOS /home
      const fakePath = join(testDir, 'foo.txt');
      const result = await check(
        'file_read',
        { path: fakePath },
        testDir,
        ctx,
      );

      expect(result.decision).toBe('allow');
    });

    test('high-risk tool still prompts even with ephemeral allow rule (no allowHighRisk)', async () => {
      const ephemeralRules: TrustRule[] = [{
        id: 'ephemeral:run-1:bash',
        tool: 'bash',
        pattern: '**',
        scope: 'everywhere',
        decision: 'allow',
        priority: 50,
        createdAt: Date.now(),
        principalKind: 'task',
        principalId: 'run-1',
        // Note: allowHighRisk is NOT set
      }];

      const ctx: PolicyContext = {
        principal: { kind: 'task', id: 'run-1' },
        ephemeralRules,
      };

      // sudo is high-risk
      const result = await check(
        'bash',
        { command: 'sudo rm -rf /' },
        '/home/user/project',
        ctx,
      );

      expect(result.decision).toBe('prompt');
    });
  });
});
