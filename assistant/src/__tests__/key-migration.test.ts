import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-migration-test-${randomBytes(4).toString('hex')}`);
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const CONFIG_PATH = join(WORKSPACE_DIR, 'config.json');
const STORE_PATH = join(TEST_DIR, 'keys.enc');

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getWorkspaceConfigPath: () => CONFIG_PATH,
  getDataDir: () => join(TEST_DIR, 'data'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  ensureDataDir: () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    if (!existsSync(WORKSPACE_DIR)) mkdirSync(WORKSPACE_DIR, { recursive: true });
    const logsDir = join(TEST_DIR, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  },
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
  migratePath: () => {},
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

import { _setStorePath } from '../security/encrypted-store.js';
import { _setBackend } from '../security/secure-keys.js';
import { loadConfig, invalidateConfigCache } from '../config/loader.js';
import { getSecureKey } from '../security/secure-keys.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// API key env vars that loadConfig checks — must be cleared during tests
// so they don't override the migrated values under test.
const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'OLLAMA_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY',
  'BRAVE_API_KEY', 'PERPLEXITY_API_KEY',
];

describe('key migration', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear API key env vars
    for (const key of API_KEY_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'logs'), { recursive: true });
    _setStorePath(STORE_PATH);
    _setBackend('encrypted');
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    _setBackend(undefined);
    invalidateConfigCache();
    // Restore API key env vars
    for (const key of API_KEY_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
  });

  test('[experimental] migrates plaintext apiKeys from config.json to secure storage', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'anthropic',
      apiKeys: {
        anthropic: 'sk-ant-test-key-123',
        openai: 'sk-openai-test-456',
      },
    }));

    const config = loadConfig();

    // Keys should be in the loaded config (from secure storage)
    expect(config.apiKeys.anthropic).toBe('sk-ant-test-key-123');
    expect(config.apiKeys.openai).toBe('sk-openai-test-456');

    // Keys should be in secure storage
    expect(getSecureKey('anthropic')).toBe('sk-ant-test-key-123');
    expect(getSecureKey('openai')).toBe('sk-openai-test-456');

    // Keys should be removed from config.json
    const rawJson = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawJson.apiKeys).toBeUndefined();
    // Other config should still be there
    expect(rawJson.provider).toBe('anthropic');
  });

  test('does not migrate when no apiKeys in config.json', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }));

    const config = loadConfig();
    expect(config.provider).toBe('anthropic');

    // Config file should be unchanged
    const rawJson = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawJson.provider).toBe('anthropic');
    expect(rawJson.model).toBe('claude-sonnet-4-6');
  });

  test('does not migrate empty apiKeys object', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'anthropic',
      apiKeys: {},
    }));

    loadConfig();

    // Config file should still have the empty apiKeys
    const rawJson = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawJson.apiKeys).toEqual({});
  });

  test('preserves other config fields during migration', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: 4096,
      apiKeys: { anthropic: 'sk-ant-test' },
      timeouts: { shellDefaultTimeoutSec: 30 },
    }));

    loadConfig();

    const rawJson = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawJson.provider).toBe('openai');
    expect(rawJson.model).toBe('gpt-4');
    expect(rawJson.maxTokens).toBe(4096);
    expect(rawJson.timeouts.shellDefaultTimeoutSec).toBe(30);
    expect(rawJson.apiKeys).toBeUndefined();
  });

  test('[experimental] migration only happens once (idempotent)', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'anthropic',
      apiKeys: { anthropic: 'sk-ant-test-key' },
    }));

    // First load — triggers migration
    loadConfig();
    expect(getSecureKey('anthropic')).toBe('sk-ant-test-key');

    // Verify config.json no longer has apiKeys
    const rawAfter = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(rawAfter.apiKeys).toBeUndefined();

    // Second load — should not error or duplicate
    invalidateConfigCache();
    const config2 = loadConfig();
    expect(config2.apiKeys.anthropic).toBe('sk-ant-test-key');
  });

  test('skips non-string values in apiKeys during migration', () => {
    const configPath = CONFIG_PATH;
    writeFileSync(configPath, JSON.stringify({
      provider: 'anthropic',
      apiKeys: {
        anthropic: 'sk-ant-valid',
        broken: 123,
        empty: '',
      },
    }));

    loadConfig();

    // Only the valid key should be migrated
    expect(getSecureKey('anthropic')).toBe('sk-ant-valid');
    expect(getSecureKey('broken')).toBeUndefined();
    expect(getSecureKey('empty')).toBeUndefined();
  });
});
