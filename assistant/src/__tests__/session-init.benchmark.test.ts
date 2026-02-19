/**
 * Session Initialization Benchmark
 *
 * Measures latency of key session startup components:
 * - Tool registry initialization (initializeTools)
 * - System prompt assembly (buildSystemPrompt)
 * - Tool definitions retrieval (getAllToolDefinitions)
 *
 * Target ranges (first green run):
 * - initializeTools: < 250ms
 * - buildSystemPrompt: < 50ms
 * - getAllToolDefinitions: < 10ms
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'session-init-bench-'));

// Create subdirectories expected by platform helpers
mkdirSync(join(testDir, 'data'), { recursive: true });
mkdirSync(join(testDir, 'logs'), { recursive: true });
mkdirSync(join(testDir, 'skills'), { recursive: true });
mkdirSync(join(testDir, 'hooks'), { recursive: true });

// Seed minimal prompt files so buildSystemPrompt doesn't bail on missing files
writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Identity\nYou are a test assistant.');
writeFileSync(join(testDir, 'SOUL.md'), '# Test Soul\nBe helpful.');
writeFileSync(join(testDir, 'USER.md'), '# Test User\nName: Benchmark Runner');

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  getWorkspaceDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  getWorkspaceSkillsDir: () => join(testDir, 'skills'),
  getWorkspaceHooksDir: () => join(testDir, 'hooks'),
  getWorkspacePromptPath: (file: string) => join(testDir, file),
  getSocketPath: () => join(testDir, 'test.sock'),
  getSessionTokenPath: () => join(testDir, 'session-token'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'data', 'test.db'),
  getLogPath: () => join(testDir, 'logs', 'test.log'),
  getHistoryPath: () => join(testDir, 'history'),
  getHooksDir: () => join(testDir, 'hooks'),
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
  getSandboxRootDir: () => join(testDir, 'sandbox'),
  getSandboxWorkingDir: () => testDir,
  getInterfacesDir: () => join(testDir, 'interfaces'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string, maxLen = 500) =>
    value.length > maxLen ? value.slice(0, maxLen) + '...' : value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockConfig = {
  model: 'mock-model',
  provider: 'mock',
  sandbox: { enabled: false, backend: 'native' },
};

mock.module('../config/loader.js', () => ({
  API_KEY_PROVIDERS: ['anthropic', 'openai', 'gemini', 'ollama', 'fireworks', 'brave', 'perplexity'],
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { initializeTools, getAllToolDefinitions, __resetRegistryForTesting } = await import(
  '../tools/registry.js'
);
const { buildSystemPrompt } = await import('../config/system-prompt.js');

afterAll(() => {
  __resetRegistryForTesting();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

describe('Session initialization benchmark', () => {
  test('initializeTools completes under 250ms', async () => {
    __resetRegistryForTesting();

    const start = performance.now();
    await initializeTools();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(250);
  });

  test('getAllToolDefinitions retrieves definitions under 10ms', async () => {
    // Ensure tools are initialized first
    await initializeTools();

    const start = performance.now();
    const definitions = getAllToolDefinitions();
    const elapsed = performance.now() - start;

    expect(definitions.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10);
  });

  test('buildSystemPrompt assembles prompt under 50ms', () => {
    const start = performance.now();
    const prompt = buildSystemPrompt();
    const elapsed = performance.now() - start;

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Test Identity');
    expect(elapsed).toBeLessThan(50);
  });

  test('repeated buildSystemPrompt calls are consistently fast (10 iterations)', () => {
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      buildSystemPrompt();
      timings.push(performance.now() - start);
    }

    const maxTime = Math.max(...timings);
    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;

    // Each call should be under 50ms, average well under 20ms
    expect(maxTime).toBeLessThan(50);
    expect(avgTime).toBeLessThan(20);
  });

  test('tool definitions count stays within expected range after init', async () => {
    await initializeTools();
    const definitions = getAllToolDefinitions();

    // Sanity: we expect a meaningful number of core tools (at least 20)
    // but not an unreasonable explosion (under 200)
    expect(definitions.length).toBeGreaterThanOrEqual(20);
    expect(definitions.length).toBeLessThan(200);
  });
});
