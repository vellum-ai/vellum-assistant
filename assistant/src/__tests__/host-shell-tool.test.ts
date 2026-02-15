import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as realChildProcess from 'node:child_process';

// Capture the real spawn before mock.module replaces it
const originalSpawn = realChildProcess.spawn;

// Capture spawn calls to verify the host tool spawns 'bash' directly
const spawnCalls: { command: string; args: string[] }[] = [];
const spawnSpy = mock((...args: Parameters<typeof realChildProcess.spawn>) => {
  spawnCalls.push({ command: args[0] as string, args: args[1] as string[] });
  return (originalSpawn as (...a: unknown[]) => unknown)(...args);
});

mock.module('node:child_process', () => ({
  ...realChildProcess,
  spawn: spawnSpy,
}));

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
  sandbox: { enabled: true },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: true, action: 'warn' as const, entropyThreshold: 4.0 },
  auditLog: { retentionDays: 0 },
};

// Track whether wrapCommand was ever called — host_bash must never invoke it
let wrapCommandCallCount = 0;

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

mock.module('../tools/terminal/sandbox.js', () => ({
  wrapCommand: (...args: unknown[]) => {
    wrapCommandCallCount++;
    return { command: 'bash', args: ['-c', '--', args[0]], sandboxed: false };
  },
}));

import { hostShellTool } from '../tools/host-terminal/host-shell.js';
import type { ToolContext } from '../tools/types.js';

const testDirs: string[] = [];

function makeContext(): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
  };
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('host_bash tool', () => {
  test('rejects relative working_dir', async () => {
    const result = await hostShellTool.execute({
      command: 'pwd',
      working_dir: 'relative/path',
    }, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('working_dir must be absolute');
  });

  test('executes command in provided absolute working_dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-test-'));
    testDirs.push(dir);

    const result = await hostShellTool.execute({
      command: 'pwd',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe(realpathSync(dir));
  });

  test('returns error for non-zero exit commands', async () => {
    const result = await hostShellTool.execute({ command: 'exit 12' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('<command_exit code="12" />');
  });

  test('does not route through sandbox wrapCommand', async () => {
    wrapCommandCallCount = 0;

    const dir = mkdtempSync(join(tmpdir(), 'host-shell-nosandbox-'));
    testDirs.push(dir);

    const result = await hostShellTool.execute({
      command: 'echo isolation-test',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('isolation-test');
    // The sandbox wrapCommand must never be called for host_bash
    expect(wrapCommandCallCount).toBe(0);
  });

  test('spawns plain bash without sandbox-exec or bwrap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-plain-'));
    testDirs.push(dir);

    // Verify the tool executes successfully even when sandbox is enabled in config,
    // proving it bypasses the sandbox entirely
    expect(mockConfig.sandbox.enabled).toBe(true);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute({
      command: 'echo hello',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    // Verify spawn was called with 'bash' directly — not 'bwrap' or 'sandbox-exec'
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe('bash');
    expect(spawnCalls[0].args).toEqual(['-c', '--', 'echo hello']);
  });
});
