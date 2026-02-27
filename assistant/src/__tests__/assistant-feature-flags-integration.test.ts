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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const DECLARED_FLAG_KEY = 'feature_flags.hatch-new-assistant.enabled';
const DECLARED_LEGACY_KEY = 'skills.hatch-new-assistant.enabled';
const DECLARED_SKILL_ID = 'hatch-new-assistant';

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
  const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : '';
  writeFileSync(indexPath, existing + `- ${id}\n`);
}

// ---------------------------------------------------------------------------
// System prompt — assistant feature flag filtering
// ---------------------------------------------------------------------------

describe('buildSystemPrompt assistant feature flag filtering', () => {
  test('flag OFF skill does not appear in <available_skills> section', () => {
    createSkillOnDisk(DECLARED_SKILL_ID, 'Hatch New Assistant', 'Toggle hatch new assistant behavior');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    };

    const result = buildSystemPrompt();

    expect(result).toContain('id="twitter"');
    expect(result).not.toContain(`id="${DECLARED_SKILL_ID}"`);
  });

  test('all skills visible when featureFlags is empty', () => {
    createSkillOnDisk(DECLARED_SKILL_ID, 'Hatch New Assistant', 'Toggle hatch new assistant behavior');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: {},
    };

    const result = buildSystemPrompt();

    expect(result).toContain(`id="${DECLARED_SKILL_ID}"`);
    expect(result).toContain('id="twitter"');
  });

  test('flagged-off skills hidden even when all flags are OFF', () => {
    createSkillOnDisk(DECLARED_SKILL_ID, 'Hatch New Assistant', 'Toggle hatch new assistant behavior');
    createSkillOnDisk('twitter', 'Twitter', 'Post to X/Twitter');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: {
        [DECLARED_LEGACY_KEY]: false,
        'skills.twitter.enabled': false,
      },
    };

    const result = buildSystemPrompt();

    expect(result).not.toContain(`id="${DECLARED_SKILL_ID}"`);
    // Twitter is undeclared but also has an explicit persisted override (false),
    // so it should be hidden too.
    expect(result).not.toContain('id="twitter"');
  });

  test('new assistantFeatureFlagValues takes priority over legacy featureFlags', () => {
    createSkillOnDisk(DECLARED_SKILL_ID, 'Hatch New Assistant', 'Toggle hatch new assistant behavior');

    // Legacy says disabled, new section says enabled — new section wins
    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    };

    const result = buildSystemPrompt();

    expect(result).toContain(`id="${DECLARED_SKILL_ID}"`);
  });

  test('persisted overrides for undeclared flags are respected', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': false },
    };

    const result = buildSystemPrompt();

    // Even though 'browser' is not in the defaults registry, the user
    // explicitly disabled it — that override must be honored.
    expect(result).not.toContain('id="browser"');
  });

  test('undeclared flags with no persisted override default to enabled', () => {
    createSkillOnDisk('browser', 'Browser', 'Web browsing automation');

    currentConfig = {
      sandbox: { enabled: false, backend: 'native' },
      featureFlags: {},
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
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    } as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test('falls back to legacy featureFlags when new section is absent', () => {
    const config = {
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    } as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(false);
  });

  test('missing persisted value falls back to defaults registry defaultEnabled', () => {
    // No explicit config at all — should fall back to defaults registry
    // which has defaultEnabled: true for hatch-new-assistant
    const config = {
      featureFlags: {},
    } as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test('unknown flag defaults to true when no persisted override', () => {
    const config = {
      featureFlags: {},
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.unknown-skill.enabled', config)).toBe(true);
  });

  test('undeclared flag respects persisted canonical override', () => {
    const config = {
      featureFlags: {},
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': false },
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(false);
  });

  test('undeclared flag respects persisted legacy override', () => {
    const config = {
      featureFlags: { 'skills.browser.enabled': false },
    } as any;

    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(false);
  });
});

describe('isAssistantSkillEnabled', () => {
  test('convenience wrapper translates skill ID to canonical key', () => {
    const config = {
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    } as any;

    expect(isAssistantSkillEnabled(DECLARED_SKILL_ID, config)).toBe(false);
  });

  test('enabled when no flag set', () => {
    const config = { featureFlags: {} } as any;
    expect(isAssistantSkillEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });
});

describe('legacy isSkillFeatureEnabled backward compat', () => {
  test('delegates to the new resolver and reads legacy flags', () => {
    const config = {
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    } as any;

    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(false);
  });

  test('new section overrides legacy via delegation', () => {
    const config = {
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    } as any;

    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });
});
