/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'permsim-handler-test-'));

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

import { handleToolPermissionSimulate } from '../daemon/handlers/config.js';
import { addRule, clearAllRules, clearCache } from '../permissions/trust-store.js';
import type { ToolPermissionSimulateRequest, ToolPermissionSimulateResponse, ServerMessage } from '../daemon/ipc-contract.js';
import type { HandlerContext } from '../daemon/handlers.js';

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

function getResponse(sent: ServerMessage[]): ToolPermissionSimulateResponse {
  const msg = sent.find((m) => (m as any).type === 'tool_permission_simulate_response');
  if (!msg) throw new Error('No tool_permission_simulate_response found in sent messages');
  return msg as unknown as ToolPermissionSimulateResponse;
}

describe('tool_permission_simulate handler', () => {
  beforeEach(() => {
    clearAllRules();
    clearCache();
    testConfig.permissions.mode = 'legacy';
  });

  test('validation: returns error when toolName is missing', async () => {
    const { ctx, sent } = createTestContext();
    const msg = { type: 'tool_permission_simulate' } as any as ToolPermissionSimulateRequest;
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(false);
    expect(res.error).toContain('toolName is required');
  });

  test('validation: returns error when input is missing', async () => {
    const { ctx, sent } = createTestContext();
    const msg = {
      type: 'tool_permission_simulate',
      toolName: 'bash',
    } as any as ToolPermissionSimulateRequest;
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(false);
    expect(res.error).toContain('input is required');
  });

  test('low-risk auto-allow: file_read is auto-allowed', async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_read',
      input: { path: '/tmp/test.txt' },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('allow');
    expect(res.riskLevel).toBe('low');
  });

  test('deny rule produces deny decision', async () => {
    // file_write deny rule — no default allow-all rule competes
    addRule('file_write', 'file_write:/tmp/**', 'everywhere', 'deny');

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('deny');
    expect(res.matchedRuleId).toBeDefined();
  });

  test('prompt decision includes allowlist and scope options', async () => {
    const { ctx, sent } = createTestContext();
    // file_write is medium risk and will prompt without a trust rule
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('prompt');
    expect(res.promptPayload).toBeDefined();
    expect(res.promptPayload!.allowlistOptions.length).toBeGreaterThan(0);
    expect(res.promptPayload!.scopeOptions.length).toBeGreaterThan(0);
    expect(res.promptPayload!.persistentDecisionsAllowed).toBe(true);
  });

  test('proxied bash disables persistent decisions', async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'bash',
      input: { command: 'curl https://example.com', network_mode: 'proxied' },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('prompt');
    expect(res.promptPayload).toBeDefined();
    expect(res.promptPayload!.persistentDecisionsAllowed).toBe(false);
  });

  test('forcePromptSideEffects promotes allow to prompt for side-effect tools', async () => {
    // file_read is low-risk, auto-allowed, and NOT a side-effect tool
    // so we use bash with an allow rule to test the promotion
    addRule('bash', 'bash:ls*', 'everywhere', 'allow');

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'bash',
      input: { command: 'ls' },
      forcePromptSideEffects: true,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // bash is a side-effect tool, so allow gets promoted to prompt
    expect(res.decision).toBe('prompt');
    expect(res.reason).toContain('Private thread');
  });

  test('forcePromptSideEffects does not affect non-side-effect tools', async () => {
    const { ctx, sent } = createTestContext();
    // file_read is low-risk and not a side-effect tool
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_read',
      input: { path: '/tmp/test.txt' },
      forcePromptSideEffects: true,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('allow');
  });

  test('non-interactive converts prompt to deny', async () => {
    const { ctx, sent } = createTestContext();
    // file_write is medium risk → prompt without a rule
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
      isInteractive: false,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('deny');
    expect(res.reason).toContain('Non-interactive');
    // No prompt payload when decision is deny
    expect(res.promptPayload).toBeUndefined();
  });

  test('non-interactive does not affect allow decisions', async () => {
    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_read',
      input: { path: '/tmp/test.txt' },
      isInteractive: false,
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('allow');
  });

  test('allow rule with matching pattern returns allow', async () => {
    addRule('file_write', 'file_write:/tmp/**', 'everywhere', 'allow');

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('allow');
    expect(res.matchedRuleId).toBeDefined();
  });

  test('executionTarget: sandbox-scoped rule matches when simulated with sandbox target', async () => {
    addRule('file_write', 'file_write:/tmp/**', 'everywhere', 'allow', 100, {
      executionTarget: 'sandbox',
    });

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
      executionTarget: 'sandbox',
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    expect(res.decision).toBe('allow');
    expect(res.matchedRuleId).toBeDefined();
  });

  test('executionTarget: sandbox-scoped rule does NOT match when simulated with host target', async () => {
    addRule('file_write', 'file_write:/tmp/**', 'everywhere', 'allow', 100, {
      executionTarget: 'sandbox',
    });

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
      executionTarget: 'host',
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // The sandbox-scoped rule should not match a host target, so it falls
    // through to the default prompt decision for medium-risk file_write.
    expect(res.decision).toBe('prompt');
    expect(res.matchedRuleId).toBeUndefined();
  });

  test('executionTarget: sandbox-scoped rule does not match without a target in context', async () => {
    addRule('file_write', 'file_write:/tmp/**', 'everywhere', 'allow', 100, {
      executionTarget: 'sandbox',
    });

    const { ctx, sent } = createTestContext();
    const msg: ToolPermissionSimulateRequest = {
      type: 'tool_permission_simulate',
      toolName: 'file_write',
      input: { path: '/tmp/test.txt', content: 'hello' },
      // no executionTarget — context.executionTarget will be undefined
    };
    await handleToolPermissionSimulate(msg, {} as net.Socket, ctx);

    const res = getResponse(sent);
    expect(res.success).toBe(true);
    // A rule with executionTarget='sandbox' requires ctx.executionTarget='sandbox'.
    // Without a target in the context, the rule should NOT match.
    expect(res.decision).toBe('prompt');
    expect(res.matchedRuleId).toBeUndefined();
  });
});
