import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// Mock wrapCommand to pass through without actual sandboxing (tests run bun directly)
mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: (command: string, _workingDir: string, _config: unknown) => ({
    command: 'bash',
    args: ['-c', '--', command],
    sandboxed: false,
  }),
}));

import { EvaluateTypescriptTool } from '../tools/terminal/evaluate-typescript.js';
import type { ToolContext } from '../tools/types.js';

const tool = new EvaluateTypescriptTool();
const testDirs: string[] = [];

function makeContext(workingDir?: string): ToolContext {
  const dir = workingDir ?? mkdtempSync(join(tmpdir(), 'eval-ts-test-'));
  if (!workingDir) testDirs.push(dir);
  return {
    workingDir: dir,
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('evaluate_typescript_code tool', () => {
  test('successful execution returns exitCode=0 and expected output', async () => {
    const result = await tool.execute({
      code: 'export default function(input: unknown) { return { greeting: "hello" }; }',
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.timeout).toBe(false);
    expect(parsed.result).toEqual({ greeting: 'hello' });
    expect(typeof parsed.durationMs).toBe('number');
  });

  test('passes mock_input_json to snippet', async () => {
    const result = await tool.execute({
      code: 'export default function(input: any) { return { received: input }; }',
      mock_input_json: '{"name":"test"}',
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ received: { name: 'test' } });
  });

  test('syntax error returns non-zero and stderr', async () => {
    const result = await tool.execute({
      code: 'export default function( { return }',
    }, makeContext());

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.stderr.length).toBeGreaterThan(0);
  });

  test('runtime throw returns non-zero and stack fragment in stderr', async () => {
    const result = await tool.execute({
      code: 'export default function() { throw new Error("boom"); }',
    }, makeContext());

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.stderr).toContain('boom');
  });

  test('timeout kills process and returns timeout marker', async () => {
    const result = await tool.execute({
      code: 'export default async function() { await new Promise(r => setTimeout(r, 60000)); }',
      timeout_seconds: 1,
    }, makeContext());

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.timeout).toBe(true);
  }, 10_000);

  test('invalid JSON in mock_input_json returns deterministic validation error', async () => {
    const result = await tool.execute({
      code: 'export default function() { return 1; }',
      mock_input_json: 'not-json{',
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Error: mock_input_json must be valid JSON');
  });

  test('missing export returns deterministic contract error', async () => {
    const result = await tool.execute({
      code: 'const x = 42;',
    }, makeContext());

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.stderr).toContain('must export a function');
  });

  test('entrypoint=run calls the run export', async () => {
    const result = await tool.execute({
      code: 'export function run(input: any) { return "ran"; }',
      entrypoint: 'run',
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe('ran');
  });

  test('oversized code is rejected before execution', async () => {
    const result = await tool.execute({
      code: 'x'.repeat(200_000),
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds maximum size');
  });

  test('oversized mock_input_json is rejected before execution', async () => {
    const result = await tool.execute({
      code: 'export default function() { return 1; }',
      mock_input_json: JSON.stringify({ data: 'x'.repeat(200_000) }),
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeds maximum size');
  });

  test('temp directory is removed after completion', async () => {
    const ctx = makeContext();

    await tool.execute({
      code: 'export default function() { return 1; }',
    }, ctx);

    const evalDir = join(ctx.workingDir, '.vellum-eval');
    // The parent .vellum-eval dir may exist but should have no children
    if (existsSync(evalDir)) {
      expect(readdirSync(evalDir).length).toBe(0);
    }
  });

  test('empty code is rejected', async () => {
    const result = await tool.execute({
      code: '',
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('code is required');
  });

  test('missing code is rejected', async () => {
    const result = await tool.execute({}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('code is required');
  });

  test('oversized stdout is truncated', async () => {
    const result = await tool.execute({
      code: `export default function() {
        // Generate output larger than max_output_chars
        const big = 'x'.repeat(30000);
        console.log(big);
        return 'done';
      }`,
      max_output_chars: 1000,
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.stdout).toContain('[stdout truncated]');
    expect(parsed.stdout.length).toBeLessThan(2000);
  }, 10_000);

  test('async snippet works', async () => {
    const result = await tool.execute({
      code: 'export default async function(input: any) { return { async: true, got: input }; }',
      mock_input_json: '42',
    }, makeContext());

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ async: true, got: 42 });
  });
});
