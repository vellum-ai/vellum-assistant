import { describe, expect, test } from 'bun:test';

import type { AssistantConfig } from '../config/schema.js';
import { isSkillFeatureEnabled, resolveSkillStates } from '../config/skill-state.js';
import type { SkillSummary } from '../config/skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AssistantConfig with optional featureFlags. */
function makeConfig(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    featureFlags: {},
    skills: {
      entries: {},
      load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
      install: { nodeManager: 'npm' },
      allowBundled: null,
    },
    ...overrides,
  } as AssistantConfig;
}

/** Create a minimal SkillSummary for testing. */
function makeSkill(id: string, source: 'bundled' | 'managed' = 'bundled'): SkillSummary {
  return {
    id,
    name: `${id} skill`,
    description: `Description for ${id}`,
    directoryPath: `/fake/skills/${id}`,
    skillFilePath: `/fake/skills/${id}/SKILL.md`,
    bundled: source === 'bundled',
    userInvocable: true,
    disableModelInvocation: false,
    source,
  };
}

// ---------------------------------------------------------------------------
// isSkillFeatureEnabled
// ---------------------------------------------------------------------------

describe('isSkillFeatureEnabled', () => {
  test('returns true when featureFlags section is empty', () => {
    const config = makeConfig({ featureFlags: {} });
    expect(isSkillFeatureEnabled('browser', config)).toBe(true);
  });

  test('returns true when skill key is missing (default enabled)', () => {
    const config = makeConfig({
      featureFlags: { 'skills.other.enabled': true },
    });
    expect(isSkillFeatureEnabled('browser', config)).toBe(true);
  });

  test('returns true when skill key is explicitly true', () => {
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': true },
    });
    expect(isSkillFeatureEnabled('browser', config)).toBe(true);
  });

  test('returns false when skill key is explicitly false', () => {
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': false },
    });
    expect(isSkillFeatureEnabled('browser', config)).toBe(false);
  });

  test('returns true when featureFlags is undefined', () => {
    const config = makeConfig();
    // Simulate a config that somehow has no featureFlags key
    delete (config as Record<string, unknown>).featureFlags;
    expect(isSkillFeatureEnabled('browser', config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — feature flag filtering
// ---------------------------------------------------------------------------

describe('resolveSkillStates with feature flags', () => {
  test('flag OFF skill does not appear in resolved list', () => {
    const catalog = [makeSkill('browser'), makeSkill('twitter')];
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': false },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).not.toContain('browser');
    expect(ids).toContain('twitter');
  });

  test('flag ON skill appears normally', () => {
    const catalog = [makeSkill('browser'), makeSkill('twitter')];
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': true, 'skills.twitter.enabled': true },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toContain('browser');
    expect(ids).toContain('twitter');
  });

  test('missing flag key defaults to enabled', () => {
    const catalog = [makeSkill('browser')];
    const config = makeConfig({ featureFlags: {} });

    const resolved = resolveSkillStates(catalog, config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe('browser');
  });

  test('feature flag OFF takes precedence over user-enabled config entry', () => {
    const catalog = [makeSkill('browser')];
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': false },
      skills: {
        entries: { browser: { enabled: true } },
        load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
        install: { nodeManager: 'npm' },
        allowBundled: null,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    // The skill should not appear at all — feature flag is a higher-priority gate
    expect(resolved.length).toBe(0);
  });

  test('multiple skills with mixed flags', () => {
    const catalog = [
      makeSkill('browser'),
      makeSkill('twitter'),
      makeSkill('deploy'),
    ];
    const config = makeConfig({
      featureFlags: {
        'skills.browser.enabled': false,
        'skills.deploy.enabled': false,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toEqual(['twitter']);
  });
});
