import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { SecretDetectionEvent, ToolExecutionResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Mocks — MUST be declared before importing executor
// ---------------------------------------------------------------------------

const mockConfig = {
  provider: 'anthropic',
  model: 'test',
  apiKeys: {},
  maxTokens: 4096,
  dataDir: '/tmp',
  timeouts: { shellDefaultTimeoutSec: 120, shellMaxTimeoutSec: 600, permissionTimeoutSec: 300 },
  sandbox: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: true, action: 'warn' as 'redact' | 'warn' | 'block', entropyThreshold: 4.0 },
};

let fakeToolResult: ToolExecutionResult = { content: 'ok', isError: false };
const recordedInvocations: unknown[] = [];

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
}));

mock.module('../permissions/checker.js', () => ({
  classifyRisk: () => 'low',
  check: () => ({ decision: 'allow' }),
  generateAllowlistOptions: () => [],
  generateScopeOptions: () => [],
}));

mock.module('../memory/tool-usage-store.js', () => ({
  recordToolInvocation: (inv: unknown) => { recordedInvocations.push(inv); },
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
      execute: async () => fakeToolResult,
    };
  },
}));

mock.module('../tools/filesystem/fuzzy-match.js', () => ({
  findAllMatches: () => [],
  adjustIndentation: () => '',
}));
mock.module('../tools/filesystem/path-guard.js', () => ({
  validateFilePath: () => ({ ok: false }),
}));
mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: () => ({ command: '', sandboxed: false }),
}));
// NOTE: trust-store.js is intentionally NOT mocked here.  The executor only
// calls addRule() in the always_allow / always_deny code paths, which these
// tests never exercise (the mock checker always returns 'allow').  Mocking
// trust-store here would leak a stub addRule into trust-store.test.ts via
// Bun's process-global mock.module, breaking its 22 tests.

// Now import the module under test — mocks are already in place
import { ToolExecutor } from '../tools/executor.js';
import { PermissionPrompter } from '../permissions/prompter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<{ onSecretDetected: (e: SecretDetectionEvent) => void }>) {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
    ...overrides,
  };
}

function makeMockPrompter() {
  return {
    prompt: async () => ({ decision: 'allow' as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

describe('Secret scanner executor integration', () => {
  let executor: ToolExecutor;

  beforeEach(() => {
    executor = new ToolExecutor(makeMockPrompter());
    recordedInvocations.length = 0;
    mockConfig.secretDetection = { enabled: true, action: 'warn', entropyThreshold: 4.0 };
  });

  // -----------------------------------------------------------------------
  // warn mode
  // -----------------------------------------------------------------------
  test('warn mode: passes through content unchanged and fires callback', async () => {
    mockConfig.secretDetection.action = 'warn';
    const secret = 'AKIAIOSFODNN7REALKEY'; // 20-char AWS key
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    // Content should be unchanged in warn mode
    expect(result.content).toContain(secret);
    expect(result.isError).toBe(false);

    // Callback should have fired
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('file_read');
    expect(events[0].action).toBe('warn');
    expect(events[0].matches.length).toBeGreaterThan(0);
    expect(events[0].matches[0].type).toBe('AWS Access Key');
  });

  // -----------------------------------------------------------------------
  // redact mode
  // -----------------------------------------------------------------------
  test('redact mode: replaces secrets with [REDACTED:type] markers', async () => {
    mockConfig.secretDetection.action = 'redact';
    const secret = 'AKIAIOSFODNN7REALKEY';
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    expect(result.content).not.toContain(secret);
    expect(result.content).toContain('[REDACTED:AWS Access Key]');
    expect(result.isError).toBe(false);
    expect(events).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // block mode
  // -----------------------------------------------------------------------
  test('block mode: returns error and does not pass through content', async () => {
    mockConfig.secretDetection.action = 'block';
    const secret = 'AKIAIOSFODNN7REALKEY';
    fakeToolResult = { content: `Found key: ${secret}`, isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('blocked');
    expect(result.content).toContain('AWS Access Key');
    // Callback should still fire so the client gets notified
    expect(events).toHaveLength(1);
    // Invocation should be recorded for audit trail
    expect(recordedInvocations).toHaveLength(1);
    const inv = recordedInvocations[0] as Record<string, unknown>;
    expect(inv.toolName).toBe('file_read');
    expect(inv.conversationId).toBe('test-conversation');
    expect((inv.result as string)).toContain('blocked');
  });

  // -----------------------------------------------------------------------
  // disabled
  // -----------------------------------------------------------------------
  test('disabled: does not scan or fire callback', async () => {
    mockConfig.secretDetection.enabled = false;
    fakeToolResult = { content: 'Found key: AKIAIOSFODNN7REALKEY', isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    expect(result.content).toContain('AKIAIOSFODNN7REALKEY');
    expect(events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // error results are not scanned
  // -----------------------------------------------------------------------
  test('does not scan error results', async () => {
    mockConfig.secretDetection.action = 'redact';
    fakeToolResult = { content: 'Error: AKIAIOSFODNN7REALKEY', isError: true };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    // Error results should pass through without scanning
    expect(result.content).toContain('AKIAIOSFODNN7REALKEY');
    expect(events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // diff content is scanned
  // -----------------------------------------------------------------------
  test('redact mode: scans and redacts diff content', async () => {
    mockConfig.secretDetection.action = 'redact';
    const secret = 'AKIAIOSFODNN7REALKEY';
    fakeToolResult = {
      content: 'File written',
      isError: false,
      diff: {
        filePath: '/tmp/test.txt',
        oldContent: '',
        newContent: `API_KEY=${secret}`,
        isNewFile: true,
      },
    };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_write', {}, ctx);

    expect(result.diff).toBeDefined();
    expect(result.diff!.newContent).not.toContain(secret);
    expect(result.diff!.newContent).toContain('[REDACTED:AWS Access Key]');
    expect(events).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // no secrets: no callback fired
  // -----------------------------------------------------------------------
  test('no secrets: does not fire callback', async () => {
    fakeToolResult = { content: 'Hello, world!', isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    const result = await executor.execute('file_read', {}, ctx);

    expect(result.content).toBe('Hello, world!');
    expect(events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // no callback: does not throw
  // -----------------------------------------------------------------------
  test('works without onSecretDetected callback', async () => {
    mockConfig.secretDetection.action = 'warn';
    fakeToolResult = { content: 'Found key: AKIAIOSFODNN7REALKEY', isError: false };

    const ctx = makeContext(); // no onSecretDetected

    const result = await executor.execute('file_read', {}, ctx);

    // Should not throw, content unchanged in warn mode
    expect(result.content).toContain('AKIAIOSFODNN7REALKEY');
  });

  // -----------------------------------------------------------------------
  // multiple secrets
  // -----------------------------------------------------------------------
  test('detects multiple secrets in one output', async () => {
    mockConfig.secretDetection.action = 'warn';
    const aws = 'AKIAIOSFODNN7REALKEY';
    const ghToken = 'ghp_ABCDEFghijklMN0123456789abcdefghijkl';
    fakeToolResult = { content: `AWS: ${aws}\nGitHub: ${ghToken}`, isError: false };

    const events: SecretDetectionEvent[] = [];
    const ctx = makeContext({ onSecretDetected: (e) => events.push(e) });

    await executor.execute('file_read', {}, ctx);

    expect(events).toHaveLength(1);
    expect(events[0].matches.length).toBe(2);
    const types = events[0].matches.map((m) => m.type);
    expect(types).toContain('AWS Access Key');
    expect(types).toContain('GitHub Token');
  });
});
