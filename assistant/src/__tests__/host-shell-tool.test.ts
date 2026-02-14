import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  sandbox: { enabled: true },
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
});
