import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { AssistantConfigSchema } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-schema-test-${randomBytes(4).toString('hex')}`);
const CONFIG_PATH = join(TEST_DIR, 'config.json');
const STORE_PATH = join(TEST_DIR, 'keys.enc');
const LOGS_DIR = join(TEST_DIR, 'logs');

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => TEST_DIR,
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  ensureDataDir: () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const logsDir = join(TEST_DIR, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  },
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

import { _setStorePath } from '../security/encrypted-store.js';
import { _setBackend } from '../security/secure-keys.js';
import { loadConfig, invalidateConfigCache } from '../config/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tests: Zod schema (unit)
// ---------------------------------------------------------------------------

describe('AssistantConfigSchema', () => {
  test('parses empty object with full defaults', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5-20250929');
    expect(result.maxTokens).toBe(64000);
    expect(result.apiKeys).toEqual({});
    expect(result.thinking).toEqual({ enabled: false, budgetTokens: 10000 });
    expect(result.contextWindow).toEqual({
      enabled: true,
      maxInputTokens: 180000,
      targetInputTokens: 110000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 1200,
      chunkTokens: 12000,
    });
    expect(result.timeouts).toEqual({
      shellDefaultTimeoutSec: 120,
      shellMaxTimeoutSec: 600,
      permissionTimeoutSec: 300,
    });
    expect(result.sandbox).toEqual({ enabled: false });
    expect(result.rateLimit).toEqual({ maxRequestsPerMinute: 0, maxTokensPerSession: 0 });
    expect(result.secretDetection).toEqual({ enabled: true, action: 'warn', entropyThreshold: 4.0 });
    expect(result.auditLog).toEqual({ retentionDays: 0 });
  });

  test('accepts valid complete config', () => {
    const input = {
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: 4096,
      apiKeys: { openai: 'sk-test' },
      thinking: { enabled: true, budgetTokens: 5000 },
      timeouts: { shellDefaultTimeoutSec: 30, shellMaxTimeoutSec: 300, permissionTimeoutSec: 60 },
      sandbox: { enabled: true },
      rateLimit: { maxRequestsPerMinute: 10, maxTokensPerSession: 100000 },
      secretDetection: { enabled: false, action: 'block' as const, entropyThreshold: 5.5 },
      auditLog: { retentionDays: 30 },
    };
    const result = AssistantConfigSchema.parse(input);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4');
    expect(result.maxTokens).toBe(4096);
    expect(result.thinking.enabled).toBe(true);
    expect(result.secretDetection.action).toBe('block');
  });

  test('rejects invalid provider', () => {
    const result = AssistantConfigSchema.safeParse({ provider: 'invalid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('provider'))).toBe(true);
    }
  });

  test('rejects negative maxTokens', () => {
    const result = AssistantConfigSchema.safeParse({ maxTokens: -100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('maxTokens'))).toBe(true);
    }
  });

  test('rejects non-integer maxTokens', () => {
    const result = AssistantConfigSchema.safeParse({ maxTokens: 3.14 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('maxTokens'))).toBe(true);
    }
  });

  test('rejects string maxTokens', () => {
    const result = AssistantConfigSchema.safeParse({ maxTokens: 'not-a-number' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('maxTokens'))).toBe(true);
    }
  });

  test('rejects invalid timeout values', () => {
    const result = AssistantConfigSchema.safeParse({
      timeouts: { shellDefaultTimeoutSec: -5, shellMaxTimeoutSec: 'bad', permissionTimeoutSec: 0 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('rejects invalid thinking config', () => {
    const result = AssistantConfigSchema.safeParse({
      thinking: { enabled: 'yes', budgetTokens: -100 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('rejects contextWindow targetInputTokens >= maxInputTokens', () => {
    const result = AssistantConfigSchema.safeParse({
      contextWindow: { maxInputTokens: 1000, targetInputTokens: 1000 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join('.') === 'contextWindow.targetInputTokens'
            && issue.message.includes('must be less than contextWindow.maxInputTokens'),
        ),
      ).toBe(true);
    }
  });

  test('rejects invalid secretDetection.action', () => {
    const result = AssistantConfigSchema.safeParse({
      secretDetection: { action: 'explode' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('secretDetection.action'))).toBe(true);
    }
  });

  test('rejects negative secretDetection.entropyThreshold', () => {
    const result = AssistantConfigSchema.safeParse({
      secretDetection: { entropyThreshold: -1 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative rateLimit values', () => {
    const result = AssistantConfigSchema.safeParse({
      rateLimit: { maxRequestsPerMinute: -1 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer rateLimit values', () => {
    const result = AssistantConfigSchema.safeParse({
      rateLimit: { maxTokensPerSession: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative auditLog.retentionDays', () => {
    const result = AssistantConfigSchema.safeParse({
      auditLog: { retentionDays: -7 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-string apiKeys values', () => {
    const result = AssistantConfigSchema.safeParse({
      apiKeys: { anthropic: 123 },
    });
    expect(result.success).toBe(false);
  });

  test('accepts partial nested objects with defaults', () => {
    const result = AssistantConfigSchema.parse({
      timeouts: { shellDefaultTimeoutSec: 30 },
    });
    expect(result.timeouts.shellDefaultTimeoutSec).toBe(30);
    expect(result.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(result.timeouts.permissionTimeoutSec).toBe(300);
  });

  test('accepts zero for non-negative fields', () => {
    const result = AssistantConfigSchema.parse({
      rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
      auditLog: { retentionDays: 0 },
    });
    expect(result.rateLimit.maxRequestsPerMinute).toBe(0);
    expect(result.rateLimit.maxTokensPerSession).toBe(0);
    expect(result.auditLog.retentionDays).toBe(0);
  });

  test('accepts all valid provider values', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'ollama'] as const) {
      const result = AssistantConfigSchema.safeParse({ provider });
      expect(result.success).toBe(true);
    }
  });

  test('accepts all valid secretDetection.action values', () => {
    for (const action of ['redact', 'warn', 'block'] as const) {
      const result = AssistantConfigSchema.safeParse({ secretDetection: { action } });
      expect(result.success).toBe(true);
    }
  });

  test('provides helpful error messages', () => {
    const result = AssistantConfigSchema.safeParse({
      provider: 'invalid',
      maxTokens: -1,
      secretDetection: { action: 'explode' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      // Should mention the valid options
      expect(messages.some(m => m.includes('anthropic') && m.includes('openai'))).toBe(true);
      expect(messages.some(m => m.includes('positive'))).toBe(true);
      expect(messages.some(m => m.includes('redact') && m.includes('warn') && m.includes('block'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: loader integration (config file -> loadConfig with fallback)
// ---------------------------------------------------------------------------

describe('loadConfig with schema validation', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(LOGS_DIR, { recursive: true });
    rmSync(CONFIG_PATH, { force: true });
    rmSync(STORE_PATH, { force: true });
    _setStorePath(STORE_PATH);
    _setBackend('encrypted');
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    _setBackend(undefined);
    invalidateConfigCache();
  });

  // Intentionally do not remove TEST_DIR in afterAll.
  // A late async logger flush may still target logs under this path and can
  // intermittently trigger unhandled ENOENT in CI if the directory is removed.
  test('loads valid config', () => {
    writeConfig({
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: 4096,
    });
    const config = loadConfig();
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4');
    expect(config.maxTokens).toBe(4096);
  });

  test('applies defaults for missing fields', () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-5-20250929');
    expect(config.maxTokens).toBe(64000);
    expect(config.thinking).toEqual({ enabled: false, budgetTokens: 10000 });
    expect(config.contextWindow).toEqual({
      enabled: true,
      maxInputTokens: 180000,
      targetInputTokens: 110000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 1200,
      chunkTokens: 12000,
    });
  });

  test('falls back to default for invalid provider', () => {
    writeConfig({ provider: 'invalid-provider' });
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
  });

  test('falls back to default for invalid maxTokens', () => {
    writeConfig({ maxTokens: -100 });
    const config = loadConfig();
    expect(config.maxTokens).toBe(64000);
  });

  test('falls back to defaults for invalid nested values', () => {
    writeConfig({
      timeouts: { shellDefaultTimeoutSec: -5, shellMaxTimeoutSec: 'bad' },
    });
    const config = loadConfig();
    expect(config.timeouts.shellDefaultTimeoutSec).toBe(120);
    expect(config.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(config.timeouts.permissionTimeoutSec).toBe(300);
  });

  test('preserves valid fields when other fields are invalid', () => {
    writeConfig({
      provider: 'openai',
      model: 'gpt-4',
      maxTokens: -1,
      thinking: { enabled: true, budgetTokens: 5000 },
    });
    const config = loadConfig();
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4');
    expect(config.thinking.enabled).toBe(true);
    expect(config.thinking.budgetTokens).toBe(5000);
    expect(config.maxTokens).toBe(64000);
  });

  test('handles no config file', () => {
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.maxTokens).toBe(64000);
  });

  test('partial nested objects get defaults for missing fields', () => {
    writeConfig({
      timeouts: { shellDefaultTimeoutSec: 30 },
    });
    const config = loadConfig();
    expect(config.timeouts.shellDefaultTimeoutSec).toBe(30);
    expect(config.timeouts.shellMaxTimeoutSec).toBe(600);
    expect(config.timeouts.permissionTimeoutSec).toBe(300);
  });

  test('falls back for invalid secretDetection.action', () => {
    writeConfig({ secretDetection: { action: 'explode' } });
    const config = loadConfig();
    expect(config.secretDetection.action).toBe('warn');
  });

  test('falls back for invalid sandbox.enabled', () => {
    writeConfig({ sandbox: { enabled: 'yes' } });
    const config = loadConfig();
    expect(config.sandbox.enabled).toBe(false);
  });

  test('falls back for invalid contextWindow relationship', () => {
    writeConfig({ contextWindow: { maxInputTokens: 1000, targetInputTokens: 1000 } });
    const config = loadConfig();
    expect(config.contextWindow.maxInputTokens).toBe(180000);
    expect(config.contextWindow.targetInputTokens).toBe(110000);
  });

  test('falls back for invalid rateLimit values', () => {
    writeConfig({ rateLimit: { maxRequestsPerMinute: -1, maxTokensPerSession: 3.5 } });
    const config = loadConfig();
    expect(config.rateLimit.maxRequestsPerMinute).toBe(0);
    expect(config.rateLimit.maxTokensPerSession).toBe(0);
  });

  test('falls back for invalid auditLog.retentionDays', () => {
    writeConfig({ auditLog: { retentionDays: -7 } });
    const config = loadConfig();
    expect(config.auditLog.retentionDays).toBe(0);
  });

  test('does not mutate default apiKeys when fallback config is overridden by env keys', () => {
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    try {
      const testKey = ['test', 'in', 'memory', 'default', 'leak'].join('-');
      process.env.ANTHROPIC_API_KEY = testKey;
      writeConfig('this is not a config object');

      const configWithEnv = loadConfig();
      expect(configWithEnv.apiKeys.anthropic).toBe(testKey);

      invalidateConfigCache();
      delete process.env.ANTHROPIC_API_KEY;
      writeConfig('still not a config object');

      const configWithoutEnv = loadConfig();
      expect(configWithoutEnv.apiKeys.anthropic).toBeUndefined();
    } finally {
      if (originalAnthropicApiKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
