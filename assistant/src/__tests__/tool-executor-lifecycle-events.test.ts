import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ToolExecutionResult, ToolLifecycleEvent } from '../tools/types.js';

const mockConfig = {
  provider: 'anthropic',
  model: 'test',
  apiKeys: {},
  maxTokens: 4096,
  dataDir: '/tmp',
  timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600, permissionTimeoutSec: 300 },
  sandbox: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: false, action: 'warn' as const, entropyThreshold: 4.0 },
};

let checkerDecision: 'allow' | 'prompt' | 'deny' = 'allow';
let checkerReason = 'allowed';
let checkerRisk = 'low';
let promptDecision: 'allow' | 'always_allow' | 'deny' | 'always_deny' = 'allow';
let sandboxed = false;
let fakeToolResult: ToolExecutionResult = { content: 'ok', isError: false };
let toolThrow: Error | null = null;

mock.module('../config/loader.js', () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

mock.module('../permissions/checker.js', () => ({
  classifyRisk: async () => checkerRisk,
  check: async () => ({ decision: checkerDecision, reason: checkerReason }),
  generateAllowlistOptions: () => [{ label: 'exact', pattern: 'exact' }],
  generateScopeOptions: () => [{ label: '/tmp', scope: '/tmp' }],
}));

mock.module('../memory/tool-usage-store.js', () => ({
  recordToolInvocation: () => {},
}));

mock.module('../tools/registry.js', () => ({
  getTool: (name: string) => {
    if (name === 'unknown_tool') return undefined;
    return {
      name,
      description: 'test tool',
      category: 'test',
      defaultRiskLevel: 'low',
      getDefinition: () => ({}),
      execute: async () => {
        if (toolThrow) throw toolThrow;
        return fakeToolResult;
      },
    };
  },
}));

mock.module('../tools/filesystem/path-guard.js', () => ({
  validateFilePath: () => ({ ok: false }),
}));

mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: () => ({ command: '', sandboxed }),
}));

import { ToolExecutor } from '../tools/executor.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolError } from '../util/errors.js';

function makeContext(events: ToolLifecycleEvent[]) {
  return {
    workingDir: '/tmp/project',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
      events.push(event);
    },
  };
}

function makePrompter(promptImpl?: () => Promise<{ decision: 'allow' | 'always_allow' | 'deny' | 'always_deny' }>) {
  return {
    prompt: promptImpl ?? (async () => ({ decision: promptDecision })),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

describe('ToolExecutor lifecycle events', () => {
  beforeEach(() => {
    checkerDecision = 'allow';
    checkerReason = 'allowed';
    checkerRisk = 'low';
    promptDecision = 'allow';
    sandboxed = false;
    fakeToolResult = { content: 'ok', isError: false };
    toolThrow = null;
  });

  test('emits start then executed for allowed execution', async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute('file_read', { path: 'README.md' }, makeContext(events));

    expect(result).toEqual({ content: 'ok', isError: false });
    expect(events.map((event) => event.type)).toEqual(['start', 'executed']);
    expect(events[0]).toMatchObject({
      type: 'start',
      toolName: 'file_read',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      workingDir: '/tmp/project',
    });
    const executed = events[1];
    if (executed.type !== 'executed') throw new Error('Expected executed event');
    expect(executed.riskLevel).toBe('low');
    expect(executed.result).toEqual({ content: 'ok', isError: false });
    expect(executed.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('emits permission_prompt then permission_denied when user denies prompt', async () => {
    checkerDecision = 'prompt';
    checkerReason = 'medium risk: requires approval';
    checkerRisk = 'medium';
    promptDecision = 'deny';
    sandboxed = true;

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute('shell', { command: 'ls -la' }, makeContext(events));

    expect(result).toEqual({ content: 'Permission denied by user', isError: true });
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'permission_prompt',
      'permission_denied',
    ]);

    const promptEvent = events[1];
    if (promptEvent.type !== 'permission_prompt') throw new Error('Expected permission_prompt event');
    expect(promptEvent.riskLevel).toBe('medium');
    expect(promptEvent.reason).toBe('medium risk: requires approval');
    expect(promptEvent.sandboxed).toBe(true);
    expect(promptEvent.allowlistOptions).toEqual([{ label: 'exact', pattern: 'exact' }]);
    expect(promptEvent.scopeOptions).toEqual([{ label: '/tmp', scope: '/tmp' }]);

    const deniedEvent = events[2];
    if (deniedEvent.type !== 'permission_denied') throw new Error('Expected permission_denied event');
    expect(deniedEvent.decision).toBe('deny');
    expect(deniedEvent.reason).toBe('Permission denied by user');
  });

  test('emits permission_denied when blocked by deny rule', async () => {
    checkerDecision = 'deny';
    checkerReason = 'Blocked by deny rule: rm *';

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(
      makePrompter(async () => {
        throw new Error('prompter should not be called');
      }),
    );

    const result = await executor.execute('shell', { command: 'rm -rf /tmp' }, makeContext(events));

    expect(result).toEqual({ content: 'Blocked by deny rule: rm *', isError: true });
    expect(events.map((event) => event.type)).toEqual(['start', 'permission_denied']);
    const deniedEvent = events[1];
    if (deniedEvent.type !== 'permission_denied') throw new Error('Expected permission_denied event');
    expect(deniedEvent.reason).toBe('Blocked by deny rule: rm *');
  });

  test('emits error when tool execution throws', async () => {
    toolThrow = new Error('boom');

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute('file_read', {}, makeContext(events));

    expect(result.content).toContain('boom');
    expect(result.isError).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    const errorEvent = events[1];
    if (errorEvent.type !== 'error') throw new Error('Expected error event');
    expect(errorEvent.errorMessage).toBe('boom');
    expect(errorEvent.isExpected).toBe(false);
    expect(errorEvent.errorName).toBe('Error');
    expect(errorEvent.errorStack).toContain('Error: boom');
  });

  test('marks ToolError failures as expected', async () => {
    toolThrow = new ToolError('tool failed', 'file_read');

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute('file_read', {}, makeContext(events));

    expect(result).toEqual({ content: 'tool failed', isError: true });
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    const errorEvent = events[1];
    if (errorEvent.type !== 'error') throw new Error('Expected error event');
    expect(errorEvent.isExpected).toBe(true);
    expect(errorEvent.errorName).toBe('ToolError');
  });

  test('emits start and error for unknown tools', async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute('unknown_tool', { test: true }, makeContext(events));

    expect(result).toEqual({ content: 'Unknown tool: unknown_tool', isError: true });
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    const errorEvent = events[1];
    if (errorEvent.type !== 'error') throw new Error('Expected error event');
    expect(errorEvent.errorMessage).toBe('Unknown tool: unknown_tool');
    expect(errorEvent.decision).toBe('error');
    expect(errorEvent.isExpected).toBe(true);
  });

  test('does not block tool execution on unresolved lifecycle callbacks', async () => {
    const executor = new ToolExecutor(makePrompter());
    const timeoutMs = 100;

    const resultPromise = executor.execute('file_read', {}, {
      workingDir: '/tmp/project',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      onToolLifecycleEvent: () => new Promise<void>(() => {}),
    });

    const raced = Promise.race([
      resultPromise,
      new Promise<ToolExecutionResult>((_, reject) => {
        setTimeout(() => reject(new Error('execute timed out')), timeoutMs);
      }),
    ]);

    await expect(raced).resolves.toEqual({ content: 'ok', isError: false });
  });
});
