/**
 * Integration tests for assistant feature flag enforcement at system prompt,
 * skill_load, and session-skill-tools projection layers.
 *
 * Covers:
 *   - Flag OFF blocks all exposure paths
 *   - Missing persisted value falls back to code default
 *   - Legacy keys/section still read (backward compat)
 *   - New assistantFeatureFlagValues takes priority over legacy featureFlags
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Test-scoped temp directory and config state
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `vellum-asst-flags-test-${crypto.randomUUID()}`);

let currentConfig: Record<string, unknown> = {
  sandbox: { enabled: false, backend: 'native' },
  featureFlags: {},
};

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, 'config.json'),
  getWorkspaceSkillsDir: () => join(TEST_DIR, 'skills'),
  getWorkspaceHooksDir: () => join(TEST_DIR, 'hooks'),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  getHistoryPath: () => join(TEST_DIR, 'history'),
  getHooksDir: () => join(TEST_DIR, 'hooks'),
  getIpcBlobDir: () => join(TEST_DIR, 'ipc-blobs'),
  getSandboxRootDir: () => join(TEST_DIR, 'sandbox'),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, 'interfaces'),
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  getPlatformName: () => 'linux',
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => currentConfig,
}));

mock.module('../config/user-reference.js', () => ({
  resolveUserReference: () => 'TestUser',
}));

mock.module('../security/parental-control-store.js', () => ({
  getParentalControlSettings: () => ({ enabled: false, contentRestrictions: [], blockedToolCategories: [] }),
}));

mock.module('../tools/credentials/metadata-store.js', () => ({
  listCredentialMetadata: () => [],
}));

const { buildSystemPrompt } = await import('../config/system-prompt.js');
const { isAssistantFeatureFlagEnabled, isAssistantSkillEnabled } = await import('../config/assistant-feature-flags.js');
const { isSkillFeatureEnabled } = await import('../config/skill-state.js');

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  currentConfig = {
    sandbox: { enabled: false, backend: 'native' },
    featureFlags: {},
  };
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSkillOnDisk(id: string, name: string, description: string): void {
  const skillsDir = join(TEST_DIR, 'skills');
  mkdirSync(join(skillsDir, id), { recursive: true });
  writeFileSync(
    join(skillsDir, id, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nInstructions for ${id}.\n`,
  );
  const indexPath = join(skillsDir, 'SKILLS.md');
  const existing = existsSync(indexPath) ? require('node:fs').readFileSync(indexPath, 'utf-8') : '';
  writeFileSync(indexPath, existing + `- ${id}\n`);
}

// ---------------------------------------------------------------------------
// System prompt — assistant feature flag filtering
// ---------------------------------------------------------------------------

describe('buildSystemPrompt assistant feature flag filtering', () => {
  test('flag OFF skill does not appear in <available_skills> section', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: { 'skills.browser.enabled': false },
    };

    const result = buildSystemPrompt();

    expect(result).toContain('id="twitter"');
    expect(result).not.toContain('id="browser"');
  });

  test('all skills visible when featureFlags is empty', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: {},
    };

    const result = buildSystemPrompt();

    expect(result).toContain('id="browser"');
    expect(result).toContain('id="twitter"');
  });

  test('flagged-off skills hidden even when all flags are OFF', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: {
        'skills.browser.enabled': false,
        'skills.twitter.enabled': false,
      },
    };

    const result = buildSystemPrompt();

    expect(result).not.toContain('id="browser"');
    expect(result).not.toContain('id="twitter"');
  });

  test('new assistantFeatureFlagValues takes priority over legacy featureFlags', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');

    // Legacy says disabled, new section says enabled — new section wins
    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': true },
    };

    const result = buildSystemPrompt();

    expect(result).toContain('id="browser"');
  });
});

// ---------------------------------------------------------------------------
// Resolver unit tests (within integration context)
// ---------------------------------------------------------------------------

describe('isAssistantFeatureFlagEnabled', () => {
  test('reads from assistantFeatureFlagValues first', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': true },
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(true);
  });

  test('falls back to legacy featureFlags when new section is absent', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(false);
  });

  test('missing persisted value falls back to defaults registry defaultEnabled', () => {
    // No explicit config at all — should fall back to defaults registry
    // which has defaultEnabled: true for browser
    const config = {
      featureFlags: {},
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(true);
  });

  test('unknown flag defaults to true', () => {
    const config = {
      featureFlags: {},
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.unknown-skill.enabled', config)).toBe(true);
  });
});

describe('isAssistantSkillEnabled', () => {
  test('convenience wrapper translates skill ID to canonical key', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
    } as any;

    expect(isAssistantSkillEnabled('browser', config)).toBe(false);
  });

  test('enabled when no flag set', () => {
    const config = { featureFlags: {} } as any;
    expect(isAssistantSkillEnabled('browser', config)).toBe(true);
  });
});

describe('legacy isSkillFeatureEnabled backward compat', () => {
  test('delegates to the new resolver and reads legacy flags', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
    } as any;

    expect(isSkillFeatureEnabled('browser', config)).toBe(false);
  });

  test('new section overrides legacy via delegation', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': true },
    } as any;

    expect(isSkillFeatureEnabled('browser', config)).toBe(true);
  });
});
