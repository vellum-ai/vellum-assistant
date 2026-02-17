import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

const mockConfig = {
  provider: 'anthropic',
  model: 'test',
  apiKeys: {},
  maxTokens: 4096,
  dataDir: '/tmp',
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: true, action: 'warn' as const, entropyThreshold: 4.0 },
  auditLog: { retentionDays: 0 },
};

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

// Pass through without actual sandboxing so tests can run bun directly
mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: (command: string, _workingDir: string, _config: unknown) => ({
    command: 'bash',
    args: ['-c', '--', command],
    sandboxed: false,
  }),
}));

import { runSkillToolScript } from '../tools/skills/skill-script-runner.js';
import type { ToolContext } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
    ...overrides,
  };
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skill-sandbox-test-'));

  // 1. A script that returns a successful result using input.
  await writeFile(
    join(tempDir, 'success.ts'),
    `export async function run(input: any, context: any) {
  return { content: 'sandbox hello from ' + input.name, isError: false };
}`,
    'utf-8',
  );

  // 2. A script that does NOT export a run function.
  await writeFile(
    join(tempDir, 'no-run.ts'),
    `export const version = 1;`,
    'utf-8',
  );

  // 3. A script whose run function throws an error.
  await writeFile(
    join(tempDir, 'throws.ts'),
    `export async function run() {
  throw new Error('sandbox kaboom');
}`,
    'utf-8',
  );

  // 4. A script that echoes input and context back for inspection.
  await writeFile(
    join(tempDir, 'echo.ts'),
    `export async function run(input: any, context: any) {
  return {
    content: JSON.stringify({ input, workingDir: context.workingDir, sessionId: context.sessionId }),
    isError: false,
  };
}`,
    'utf-8',
  );

  // 5. A script that sleeps forever (for timeout testing).
  await writeFile(
    join(tempDir, 'hang.ts'),
    `export async function run() {
  await new Promise(resolve => setTimeout(resolve, 120_000));
  return { content: 'should not reach', isError: false };
}`,
    'utf-8',
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe('runSkillToolScript sandbox — success', () => {
  test('executes a valid script and returns its result', async () => {
    const result = await runSkillToolScript(
      tempDir, 'success.ts', { name: 'world' }, makeContext(), { target: 'sandbox' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe('sandbox hello from world');
  }, 15_000);

  test('passes input and context through to the script', async () => {
    const ctx = makeContext({ workingDir: '/my/project', sessionId: 'sess-42' });
    const result = await runSkillToolScript(
      tempDir, 'echo.ts', { foo: 'bar' }, ctx, { target: 'sandbox' },
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ foo: 'bar' });
    expect(parsed.workingDir).toBe('/my/project');
    expect(parsed.sessionId).toBe('sess-42');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('runSkillToolScript sandbox — errors', () => {
  test('returns error when script does not export a run function', async () => {
    const result = await runSkillToolScript(
      tempDir, 'no-run.ts', {}, makeContext(), { target: 'sandbox' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not export a "run" function');
  }, 15_000);

  test('returns error when script throws during execution', async () => {
    const result = await runSkillToolScript(
      tempDir, 'throws.ts', {}, makeContext(), { target: 'sandbox' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('sandbox kaboom');
  }, 15_000);

  test('returns error when script file does not exist', async () => {
    const result = await runSkillToolScript(
      tempDir, 'nonexistent.ts', {}, makeContext(), { target: 'sandbox' },
    );

    expect(result.isError).toBe(true);
    // The subprocess will fail to import the nonexistent file
  }, 15_000);

  test('times out and returns error for long-running scripts', async () => {
    const result = await runSkillToolScript(
      tempDir, 'hang.ts', {}, makeContext(), { target: 'sandbox', timeoutMs: 1_500 },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
    expect(result.status).toBe('timeout');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Routing — default target is host (in-process)
// ---------------------------------------------------------------------------

describe('runSkillToolScript routing', () => {
  test('defaults to host execution when no target is specified', async () => {
    const result = await runSkillToolScript(
      tempDir, 'success.ts', { name: 'host' }, makeContext(),
    );

    // Host path uses dynamic import, so the script runs in-process
    expect(result.isError).toBe(false);
    expect(result.content).toBe('sandbox hello from host');
  });

  test('explicit target=host uses in-process execution', async () => {
    const result = await runSkillToolScript(
      tempDir, 'success.ts', { name: 'explicit' }, makeContext(), { target: 'host' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe('sandbox hello from explicit');
  });
});
