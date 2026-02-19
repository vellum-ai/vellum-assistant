import { afterAll, describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-schema-test-${randomBytes(4).toString('hex')}`);
const WORKSPACE_DIR = join(TEST_DIR, 'workspace');
const CONFIG_PATH = join(WORKSPACE_DIR, 'config.json');

function ensureTestDir(): void {
  const dirs = [
    TEST_DIR,
    WORKSPACE_DIR,
    join(TEST_DIR, 'data'),
    join(TEST_DIR, 'memory'),
    join(TEST_DIR, 'memory', 'knowledge'),
    join(TEST_DIR, 'logs'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

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
  ensureDataDir: () => ensureTestDir(),
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

import { _setStorePath } from '../security/encrypted-store.js';
import { _setBackend } from '../security/secure-keys.js';
import { loadConfig, invalidateConfigCache } from '../config/loader.js';
import { AssistantConfigSchema } from '../config/schema.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

afterAll(() => {
  mock.restore();
});

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
    expect(result.model).toBe('claude-opus-4-6');
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
      toolExecutionTimeoutSec: 120,
      providerStreamTimeoutSec: 300,
    });
    expect(result.sandbox).toEqual({
      enabled: true,
      backend: 'docker',
      docker: {
        image: 'vellum-sandbox:latest',
        shell: 'bash',
        cpus: 1,
        memoryMb: 512,
        pidsLimit: 256,
        network: 'none',
      },
    });
    expect(result.rateLimit).toEqual({ maxRequestsPerMinute: 0, maxTokensPerSession: 0 });
    expect(result.secretDetection).toEqual({ enabled: true, action: 'redact', entropyThreshold: 4.0, allowOneTimeSend: false, blockIngress: true });
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

  test('applies memory.conflicts defaults', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.conflicts).toEqual({
      enabled: true,
      gateMode: 'soft',
      reaskCooldownTurns: 3,
      resolverLlmTimeoutMs: 12000,
      relevanceThreshold: 0.3,
    });
  });

  test('rejects invalid memory.conflicts.relevanceThreshold', () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { conflicts: { relevanceThreshold: 2 } },
    });
    expect(result.success).toBe(false);
  });

  test('applies memory.profile defaults', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.profile).toEqual({
      enabled: true,
      maxInjectTokens: 800,
    });
  });

  test('rejects invalid memory.profile.maxInjectTokens', () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { profile: { maxInjectTokens: 0 } },
    });
    expect(result.success).toBe(false);
  });

  test('applies rollout defaults for dynamic budget and entity relation features', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.retrieval.dynamicBudget).toEqual({
      enabled: true,
      minInjectTokens: 1200,
      maxInjectTokens: 10000,
      targetHeadroomTokens: 10000,
    });
    expect(result.memory.entity.extractRelations).toEqual({
      enabled: true,
      backfillBatchSize: 200,
    });
    expect(result.memory.entity.relationRetrieval).toEqual({
      enabled: true,
      maxSeedEntities: 8,
      maxNeighborEntities: 20,
      maxEdges: 40,
      neighborScoreMultiplier: 0.7,
      maxDepth: 3,
    });
  });

  test('applies memory.cleanup defaults', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.memory.cleanup).toEqual({
      enabled: true,
      enqueueIntervalMs: 6 * 60 * 60 * 1000,
      resolvedConflictRetentionMs: 30 * 24 * 60 * 60 * 1000,
      supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
    });
  });

  test('rejects invalid memory.cleanup.enqueueIntervalMs', () => {
    const result = AssistantConfigSchema.safeParse({
      memory: { cleanup: { enqueueIntervalMs: 0 } },
    });
    expect(result.success).toBe(false);
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

  // SANDBOX M11 cutover: Docker is now the default backend for stronger
  // container-level isolation. Native is available as opt-in fallback.
  test('default sandbox backend is docker', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.sandbox.backend).toBe('docker');
  });

  test('DEFAULT_CONFIG sandbox backend is docker', () => {
    expect(DEFAULT_CONFIG.sandbox.backend).toBe('docker');
  });

  test('backward compatibility: sandbox with only enabled still parses', () => {
    const result = AssistantConfigSchema.parse({ sandbox: { enabled: false } });
    expect(result.sandbox.enabled).toBe(false);
    expect(result.sandbox.backend).toBe('docker');
    expect(result.sandbox.docker.memoryMb).toBe(512);
  });

  test('accepts docker backend with custom limits', () => {
    const result = AssistantConfigSchema.parse({
      sandbox: {
        enabled: true,
        backend: 'docker',
        docker: {
          image: 'ubuntu:22.04',
          cpus: 2,
          memoryMb: 1024,
          pidsLimit: 512,
          network: 'bridge',
        },
      },
    });
    expect(result.sandbox.backend).toBe('docker');
    expect(result.sandbox.docker.image).toBe('ubuntu:22.04');
    expect(result.sandbox.docker.cpus).toBe(2);
    expect(result.sandbox.docker.memoryMb).toBe(1024);
    expect(result.sandbox.docker.pidsLimit).toBe(512);
    expect(result.sandbox.docker.network).toBe('bridge');
  });

  test('applies docker defaults when backend is docker but docker config omitted', () => {
    const result = AssistantConfigSchema.parse({
      sandbox: { backend: 'docker' },
    });
    expect(result.sandbox.backend).toBe('docker');
    expect(result.sandbox.docker.cpus).toBe(1);
    expect(result.sandbox.docker.memoryMb).toBe(512);
    expect(result.sandbox.docker.pidsLimit).toBe(256);
    expect(result.sandbox.docker.network).toBe('none');
  });

  test('accepts partial docker config with defaults for missing fields', () => {
    const result = AssistantConfigSchema.parse({
      sandbox: {
        backend: 'docker',
        docker: { memoryMb: 2048 },
      },
    });
    expect(result.sandbox.docker.memoryMb).toBe(2048);
    expect(result.sandbox.docker.cpus).toBe(1);
    expect(result.sandbox.docker.pidsLimit).toBe(256);
    expect(result.sandbox.docker.network).toBe('none');
  });

  test('rejects invalid sandbox.backend', () => {
    const result = AssistantConfigSchema.safeParse({
      sandbox: { backend: 'podman' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('sandbox.backend'))).toBe(true);
    }
  });

  test('rejects invalid docker.network', () => {
    const result = AssistantConfigSchema.safeParse({
      sandbox: { docker: { network: 'host' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('sandbox.docker.network'))).toBe(true);
    }
  });

  test('rejects non-positive docker.memoryMb', () => {
    const result = AssistantConfigSchema.safeParse({
      sandbox: { docker: { memoryMb: 0 } },
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer docker.pidsLimit', () => {
    const result = AssistantConfigSchema.safeParse({
      sandbox: { docker: { pidsLimit: 3.5 } },
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative docker.cpus', () => {
    const result = AssistantConfigSchema.safeParse({
      sandbox: { docker: { cpus: -1 } },
    });
    expect(result.success).toBe(false);
  });

  test('defaults permissions.mode to strict', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.permissions).toEqual({ mode: 'strict' });
  });

  test('accepts explicit permissions.mode strict', () => {
    const result = AssistantConfigSchema.parse({
      permissions: { mode: 'strict' },
    });
    expect(result.permissions.mode).toBe('strict');
  });

  test('accepts explicit permissions.mode legacy', () => {
    const result = AssistantConfigSchema.parse({
      permissions: { mode: 'legacy' },
    });
    expect(result.permissions.mode).toBe('legacy');
  });

  test('rejects invalid permissions.mode', () => {
    const result = AssistantConfigSchema.safeParse({
      permissions: { mode: 'permissive' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map(i => i.message);
      expect(msgs.some(m => m.includes('permissions.mode'))).toBe(true);
    }
  });

  test('applies workspaceGit defaults including interactiveGitTimeoutMs', () => {
    const result = AssistantConfigSchema.parse({});
    expect(result.workspaceGit).toEqual({
      turnCommitMaxWaitMs: 4000,
      failureBackoffBaseMs: 2000,
      failureBackoffMaxMs: 60000,
      interactiveGitTimeoutMs: 10000,
      enrichmentQueueSize: 50,
      enrichmentConcurrency: 1,
      enrichmentJobTimeoutMs: 30000,
      enrichmentMaxRetries: 2,
    });
  });

  test('accepts custom workspaceGit.interactiveGitTimeoutMs', () => {
    const result = AssistantConfigSchema.parse({
      workspaceGit: { interactiveGitTimeoutMs: 5000 },
    });
    expect(result.workspaceGit.interactiveGitTimeoutMs).toBe(5000);
    // Other fields should still get defaults
    expect(result.workspaceGit.turnCommitMaxWaitMs).toBe(4000);
  });

  test('rejects non-positive workspaceGit.interactiveGitTimeoutMs', () => {
    const zeroResult = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: 0 },
    });
    expect(zeroResult.success).toBe(false);

    const negativeResult = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: -1 },
    });
    expect(negativeResult.success).toBe(false);
  });

  test('rejects non-integer workspaceGit.interactiveGitTimeoutMs', () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: 3.5 },
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-number workspaceGit.interactiveGitTimeoutMs', () => {
    const result = AssistantConfigSchema.safeParse({
      workspaceGit: { interactiveGitTimeoutMs: 'fast' },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: loader integration (config file -> loadConfig with fallback)
// ---------------------------------------------------------------------------

describe('loadConfig with schema validation', () => {
  beforeEach(() => {
    // Keep TEST_DIR and logs in place to avoid racing async logger stream init.
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(TEST_DIR, 'keys.enc'),
      join(TEST_DIR, 'data'),
      join(TEST_DIR, 'memory'),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    _setStorePath(join(TEST_DIR, 'keys.enc'));
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
    expect(config.model).toBe('claude-opus-4-6');
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
    expect(config.secretDetection.action).toBe('redact');
  });

  test('falls back for invalid sandbox.enabled', () => {
    writeConfig({ sandbox: { enabled: 'yes' } });
    const config = loadConfig();
    expect(config.sandbox.enabled).toBe(true);
  });

  test('loads sandbox with only enabled (backward compatibility)', () => {
    writeConfig({ sandbox: { enabled: false } });
    const config = loadConfig();
    expect(config.sandbox.enabled).toBe(false);
    expect(config.sandbox.backend).toBe('docker');
    expect(config.sandbox.docker.memoryMb).toBe(512);
  });

  test('loads sandbox docker backend config', () => {
    writeConfig({
      sandbox: {
        backend: 'docker',
        docker: { memoryMb: 2048, network: 'bridge' },
      },
    });
    const config = loadConfig();
    expect(config.sandbox.backend).toBe('docker');
    expect(config.sandbox.docker.memoryMb).toBe(2048);
    expect(config.sandbox.docker.network).toBe('bridge');
    expect(config.sandbox.docker.cpus).toBe(1);
  });

  test('falls back for invalid sandbox.backend', () => {
    writeConfig({ sandbox: { backend: 'podman' } });
    const config = loadConfig();
    expect(config.sandbox.backend).toBe('docker');
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

  test('defaults permissions.mode to strict when not specified', () => {
    writeConfig({});
    const config = loadConfig();
    expect(config.permissions).toEqual({ mode: 'strict' });
  });

  test('loads explicit permissions.mode strict', () => {
    writeConfig({ permissions: { mode: 'strict' } });
    const config = loadConfig();
    expect(config.permissions.mode).toBe('strict');
  });

  test('falls back for invalid permissions.mode', () => {
    writeConfig({ permissions: { mode: 'yolo' } });
    const config = loadConfig();
    expect(config.permissions.mode).toBe('strict');
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
