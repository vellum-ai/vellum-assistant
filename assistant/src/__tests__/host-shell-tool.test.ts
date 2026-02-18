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

// ---------------------------------------------------------------------------
// Baseline: host_bash bypasses all sandbox wrappers
// ---------------------------------------------------------------------------

describe('host_bash — baseline: no sandbox isolation', () => {
  test('does not use Docker wrapper (no "docker" as spawn command)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-no-docker-'));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute({
      command: 'echo baseline',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    // The spawn command must be 'bash', never 'docker'
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe('bash');
    expect(spawnCalls[0].command).not.toBe('docker');
  });

  test('does not use sandbox-exec or bwrap wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-no-native-'));
    testDirs.push(dir);

    spawnCalls.length = 0;

    const result = await hostShellTool.execute({
      command: 'echo no-native-sandbox',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(spawnCalls[0].command).not.toBe('sandbox-exec');
    expect(spawnCalls[0].command).not.toBe('bwrap');
  });

  test('runs directly with bash -c -- <command> args format', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-args-'));
    testDirs.push(dir);

    spawnCalls.length = 0;

    await hostShellTool.execute({
      command: 'ls -la /tmp',
      working_dir: dir,
    }, makeContext());

    expect(spawnCalls[0].command).toBe('bash');
    expect(spawnCalls[0].args[0]).toBe('-c');
    expect(spawnCalls[0].args[1]).toBe('--');
    expect(spawnCalls[0].args[2]).toBe('ls -la /tmp');
  });

  test('sandbox config being enabled does not affect host_bash', async () => {
    // The mock config has sandbox.enabled = true
    expect(mockConfig.sandbox.enabled).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'host-shell-sandbox-cfg-'));
    testDirs.push(dir);

    spawnCalls.length = 0;
    wrapCommandCallCount = 0;

    const result = await hostShellTool.execute({
      command: 'echo sandbox-enabled-irrelevant',
      working_dir: dir,
    }, makeContext());

    expect(result.isError).toBe(false);
    // Must never call wrapCommand regardless of config
    expect(wrapCommandCallCount).toBe(0);
    // Must still spawn plain bash
    expect(spawnCalls[0].command).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// Regression: host_bash must NOT gain proxied-mode properties
// ---------------------------------------------------------------------------
// The sandboxed `bash` tool gained `network_mode` and `credential_ids` in
// the media-reuse rollout (PR 13). The `host_bash` tool must never acquire
// these — it runs unsandboxed on the host and has no proxy infrastructure.
// These tests lock that boundary so any accidental addition is caught.

describe('host_bash — regression: no proxied-mode additions', () => {
  const definition = hostShellTool.getDefinition();
  const schemaProps = (definition.input_schema as Record<string, unknown>).properties as Record<string, unknown>;

  test('schema does not include network_mode property', () => {
    expect(schemaProps).not.toHaveProperty('network_mode');
  });

  test('schema does not include credential_ids property', () => {
    expect(schemaProps).not.toHaveProperty('credential_ids');
  });

  test('schema only contains the expected properties (command, working_dir, timeout_seconds)', () => {
    const propertyNames = Object.keys(schemaProps).sort();
    expect(propertyNames).toEqual(['command', 'timeout_seconds', 'working_dir']);
  });

  test('execute ignores network_mode even if supplied in input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-ignore-network-'));
    testDirs.push(dir);

    spawnCalls.length = 0;
    wrapCommandCallCount = 0;

    // Pass network_mode as if the model hallucinated the parameter —
    // host_bash must ignore it and run the command normally.
    const result = await hostShellTool.execute({
      command: 'echo should-work',
      working_dir: dir,
      network_mode: 'proxied',
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('should-work');
    // Must still spawn plain bash, not anything proxy-related
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe('bash');
    // Must never route through sandbox wrapCommand, even with proxied-mode input
    expect(wrapCommandCallCount).toBe(0);
  });

  test('execute ignores credential_ids even if supplied in input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shell-ignore-creds-'));
    testDirs.push(dir);

    spawnCalls.length = 0;
    wrapCommandCallCount = 0;

    const result = await hostShellTool.execute({
      command: 'echo creds-ignored',
      working_dir: dir,
      credential_ids: ['gmail-oauth', 'github-token'],
    }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe('creds-ignored');
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].command).toBe('bash');
    // Must never route through sandbox wrapCommand, even with credential inputs
    expect(wrapCommandCallCount).toBe(0);
  });

  test('tool name is host_bash (not bash)', () => {
    expect(definition.name).toBe('host_bash');
  });

  test('required fields only contains command', () => {
    expect((definition.input_schema as Record<string, unknown>).required).toEqual(['command']);
  });
});
