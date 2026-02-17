import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { ToolExecutionResult, Tool } from '../tools/types.js';
import type { PolicyContext } from '../permissions/types.js';

const mockConfig = {
  provider: 'anthropic',
  model: 'test',
  apiKeys: {},
  maxTokens: 4096,
  dataDir: '/tmp',
  timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600, permissionTimeoutSec: 300 },
  sandbox: { enabled: false, backend: 'native' as const, docker: { image: 'node:20-slim', cpus: 1, memoryMb: 512, pidsLimit: 256, network: 'none' as const } },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: false, action: 'warn' as const, entropyThreshold: 4.0 },
};

let fakeToolResult: ToolExecutionResult = { content: 'ok', isError: false };

/** Captured arguments from the last check() call, for assertion in tests. */
let lastCheckArgs: { toolName: string; input: Record<string, unknown>; workingDir: string; policyContext?: PolicyContext } | undefined;

/** Optional override for getTool — lets tests supply skill-origin tools. */
let getToolOverride: ((name: string) => Tool | undefined) | undefined;

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
  classifyRisk: async () => 'low',
  check: async (toolName: string, input: Record<string, unknown>, workingDir: string, policyContext?: PolicyContext) => {
    lastCheckArgs = { toolName, input, workingDir, policyContext };
    return { decision: 'allow', reason: 'allowed' };
  },
  generateAllowlistOptions: () => [{ label: 'exact', description: 'exact', pattern: 'exact' }],
  generateScopeOptions: () => [{ label: '/tmp', scope: '/tmp' }],
}));

mock.module('../memory/tool-usage-store.js', () => ({
  recordToolInvocation: () => {},
}));

mock.module('../tools/registry.js', () => ({
  getTool: (name: string) => {
    if (getToolOverride) return getToolOverride(name);
    if (name === 'unknown_tool') return undefined;
    return {
      name,
      description: 'test tool',
      category: 'test',
      defaultRiskLevel: 'low',
      getDefinition: () => ({}),
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

mock.module('../tools/shared/filesystem/path-policy.js', () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: () => ({ command: '', sandboxed: false }),
}));

import { ToolExecutor } from '../tools/executor.js';
import type { ToolContext } from '../tools/types.js';
import { PermissionPrompter } from '../permissions/prompter.js';

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: '/tmp/project',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    ...overrides,
  };
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: 'allow' as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

afterAll(() => { mock.restore(); });

describe('ToolExecutor allowedToolNames gating', () => {
  beforeEach(() => {
    fakeToolResult = { content: 'ok', isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
  });

  test('executes normally when allowedToolNames is not set (backward compat)', async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('file_read', { path: 'README.md' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok');
  });

  test('executes normally when tool is in the allowed set', async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(['file_read', 'file_write', 'bash']);
    const result = await executor.execute('file_read', { path: 'README.md' }, makeContext({ allowedToolNames: allowed }));
    expect(result.isError).toBe(false);
    expect(result.content).toBe('ok');
  });

  test('blocks execution when tool is NOT in the allowed set', async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(['file_read', 'bash']);
    const result = await executor.execute('file_write', { path: 'test.txt', content: 'hello' }, makeContext({ allowedToolNames: allowed }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not currently active');
  });

  test('error message includes the blocked tool name', async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(['bash']);
    const result = await executor.execute('file_edit', { path: 'x' }, makeContext({ allowedToolNames: allowed }));
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Tool "file_edit" is not currently active. Load the skill that provides this tool first.');
  });

  test('empty allowed set blocks all tools', async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set<string>();
    const result = await executor.execute('file_read', { path: 'README.md' }, makeContext({ allowedToolNames: allowed }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('file_read');
    expect(result.content).toContain('not currently active');
  });
});

describe('ToolExecutor principal context plumbing', () => {
  beforeEach(() => {
    fakeToolResult = { content: 'ok', isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
  });

  test('passes PolicyContext with skill principal for skill-origin tools', async () => {
    getToolOverride = (name: string) => {
      if (name === 'unknown_tool') return undefined;
      return {
        name,
        description: 'skill tool',
        category: 'skill',
        defaultRiskLevel: 'low' as const,
        origin: 'skill' as const,
        ownerSkillId: 'my-skill-123',
        ownerSkillVersionHash: 'abc123hash',
        executionTarget: 'sandbox' as const,
        getDefinition: () => ({ name, description: 'skill tool', input_schema: { type: 'object' as const, properties: {} } }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('skill_tool', { action: 'run' }, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      principal: {
        kind: 'skill',
        id: 'my-skill-123',
        version: 'abc123hash',
      },
      executionTarget: 'sandbox',
    });
  });

  test('passes undefined policyContext for core tools (no origin)', async () => {
    // Default getTool returns core tools with no origin field
    getToolOverride = undefined;

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('file_read', { path: 'test.txt' }, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toBeUndefined();
  });

  test('passes undefined policyContext for tools with origin "core"', async () => {
    getToolOverride = (name: string) => {
      if (name === 'unknown_tool') return undefined;
      return {
        name,
        description: 'core tool',
        category: 'core',
        defaultRiskLevel: 'low' as const,
        origin: 'core' as const,
        getDefinition: () => ({ name, description: 'core tool', input_schema: { type: 'object' as const, properties: {} } }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('file_read', { path: 'test.txt' }, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toBeUndefined();
  });

  test('includes executionTarget "host" from skill tool metadata', async () => {
    getToolOverride = (name: string) => {
      if (name === 'unknown_tool') return undefined;
      return {
        name,
        description: 'host skill tool',
        category: 'skill',
        defaultRiskLevel: 'low' as const,
        origin: 'skill' as const,
        ownerSkillId: 'host-skill',
        ownerSkillVersionHash: 'host-hash',
        executionTarget: 'host' as const,
        getDefinition: () => ({ name, description: 'host skill tool', input_schema: { type: 'object' as const, properties: {} } }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('host_skill_tool', { action: 'run' }, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      principal: {
        kind: 'skill',
        id: 'host-skill',
        version: 'host-hash',
      },
      executionTarget: 'host',
    });
  });

  test('skill tool without version hash passes undefined version in principal', async () => {
    getToolOverride = (name: string) => {
      if (name === 'unknown_tool') return undefined;
      return {
        name,
        description: 'skill without hash',
        category: 'skill',
        defaultRiskLevel: 'low' as const,
        origin: 'skill' as const,
        ownerSkillId: 'no-hash-skill',
        // ownerSkillVersionHash intentionally omitted
        getDefinition: () => ({ name, description: 'skill tool', input_schema: { type: 'object' as const, properties: {} } }),
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute('no_hash_tool', {}, makeContext());

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      principal: {
        kind: 'skill',
        id: 'no-hash-skill',
        version: undefined,
      },
      executionTarget: undefined,
    });
  });
});
