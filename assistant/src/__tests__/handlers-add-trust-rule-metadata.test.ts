/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { mock } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'trust-rule-metadata-test-'));

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
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
}));

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

const testConfig: Record<string, any> = {
  permissions: { mode: 'legacy' as 'legacy' | 'strict' | 'workspace' },
  skills: { load: { extraDirs: [] as string[] } },
  sandbox: { enabled: true },
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

import { handleAddTrustRule } from '../daemon/handlers/config.js';
import { getAllRules, clearAllRules, clearCache } from '../permissions/trust-store.js';
import type { AddTrustRule } from '../daemon/ipc-contract.js';
import type { HandlerContext } from '../daemon/handlers.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new Map(),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => { sent.push(msg); },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => { throw new Error('not implemented'); },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe('handleAddTrustRule metadata plumbing', () => {
  beforeEach(() => {
    clearAllRules();
    clearCache();
  });

  test('persists allowHighRisk and executionTarget fields when provided', () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: 'add_trust_rule',
      toolName: 'bash',
      pattern: 'git *',
      scope: '/projects/my-app',
      decision: 'allow',
      allowHighRisk: true,
      executionTarget: 'host',
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find((r) => r.tool === 'bash' && r.pattern === 'git *');
    expect(userRule).toBeDefined();
    expect(userRule!.allowHighRisk).toBe(true);
    expect(userRule!.executionTarget).toBe('host');
  });

  test('backward compatibility: rules work without any metadata fields', () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: 'add_trust_rule',
      toolName: 'file_write',
      pattern: '**',
      scope: 'everywhere',
      decision: 'allow',
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find((r) => r.tool === 'file_write' && r.pattern === '**');
    expect(userRule).toBeDefined();
    expect(userRule!.decision).toBe('allow');
    // Metadata fields should be absent
    expect(userRule!.allowHighRisk).toBeUndefined();
    expect(userRule!.executionTarget).toBeUndefined();
  });

  test('rule can be retrieved after being added with metadata', () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: 'add_trust_rule',
      toolName: 'bash',
      pattern: 'npm install *',
      scope: '/projects/web',
      decision: 'allow',
      allowHighRisk: false,
      executionTarget: 'sandbox',
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    // Force re-read from disk to verify persistence
    clearCache();
    const rules = getAllRules();
    const userRule = rules.find((r) => r.tool === 'bash' && r.pattern === 'npm install *');
    expect(userRule).toBeDefined();
    expect(userRule!.scope).toBe('/projects/web');
    expect(userRule!.decision).toBe('allow');
    expect(userRule!.allowHighRisk).toBe(false);
    expect(userRule!.executionTarget).toBe('sandbox');
  });

  test('partial metadata: only allowHighRisk is forwarded when others are absent', () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: 'add_trust_rule',
      toolName: 'bash',
      pattern: 'docker *',
      scope: 'everywhere',
      decision: 'allow',
      allowHighRisk: true,
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find((r) => r.tool === 'bash' && r.pattern === 'docker *');
    expect(userRule).toBeDefined();
    expect(userRule!.allowHighRisk).toBe(true);
    expect(userRule!.executionTarget).toBeUndefined();
  });

  test('partial metadata: only executionTarget is forwarded when others are absent', () => {
    const { ctx } = createTestContext();
    const msg: AddTrustRule = {
      type: 'add_trust_rule',
      toolName: 'bash',
      pattern: 'curl *',
      scope: 'everywhere',
      decision: 'allow',
      executionTarget: 'sandbox',
    };

    handleAddTrustRule(msg, {} as net.Socket, ctx);

    const rules = getAllRules();
    const userRule = rules.find((r) => r.tool === 'bash' && r.pattern === 'curl *');
    expect(userRule).toBeDefined();
    expect(userRule!.executionTarget).toBe('sandbox');
    expect(userRule!.allowHighRisk).toBeUndefined();
  });
});
