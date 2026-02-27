import { describe, expect, test } from 'bun:test';

import { isAssistantFeatureFlagEnabled, isAssistantSkillEnabled } from '../config/assistant-feature-flags.js';
import type { AssistantConfig } from '../config/schema.js';
import { isSkillFeatureEnabled, resolveSkillStates } from '../config/skill-state.js';
import type { SkillSummary } from '../config/skills.js';

const DECLARED_FLAG_KEY = 'feature_flags.hatch-new-assistant.enabled';
const DECLARED_LEGACY_KEY = 'skills.hatch-new-assistant.enabled';
const DECLARED_SKILL_ID = 'hatch-new-assistant';

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
      remoteProviders: { skillssh: { enabled: true }, clawhub: { enabled: true } },
      remotePolicy: { blockSuspicious: true, blockMalware: true, maxSkillsShRisk: 'medium' },
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
// isSkillFeatureEnabled (legacy wrapper — backward compat)
// ---------------------------------------------------------------------------

describe('isSkillFeatureEnabled', () => {
  test('returns true when featureFlags section is empty', () => {
    const config = makeConfig({ featureFlags: {} });
    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });

  test('returns true when skill key is missing (default enabled)', () => {
    const config = makeConfig({
      featureFlags: { 'skills.other.enabled': true },
    });
    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });

  test('returns true when skill key is explicitly true', () => {
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: true },
    });
    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });

  test('returns false when skill key is explicitly false', () => {
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    });
    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(false);
  });

  test('returns true when featureFlags is undefined', () => {
    const config = makeConfig();
    // Simulate a config that somehow has no featureFlags key
    delete (config as Record<string, unknown>).featureFlags;
    expect(isSkillFeatureEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAssistantSkillEnabled (new canonical resolver)
// ---------------------------------------------------------------------------

describe('isAssistantSkillEnabled', () => {
  test('returns true when no flags set', () => {
    const config = makeConfig({ featureFlags: {} });
    expect(isAssistantSkillEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });

  test('reads legacy featureFlags section', () => {
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    });
    expect(isAssistantSkillEnabled(DECLARED_SKILL_ID, config)).toBe(false);
  });

  test('new assistantFeatureFlagValues overrides legacy', () => {
    const config = {
      ...makeConfig({ featureFlags: { [DECLARED_LEGACY_KEY]: false } }),
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    } as AssistantConfig;
    expect(isAssistantSkillEnabled(DECLARED_SKILL_ID, config)).toBe(true);
  });

  test('ignores persisted values for undeclared skills', () => {
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': false },
    });
    expect(isAssistantSkillEnabled('browser', config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAssistantFeatureFlagEnabled (full canonical key)
// ---------------------------------------------------------------------------

describe('isAssistantFeatureFlagEnabled', () => {
  test('returns true for unknown flags (open by default)', () => {
    const config = makeConfig({ featureFlags: {} });
    expect(isAssistantFeatureFlagEnabled('feature_flags.unknown.enabled', config)).toBe(true);
  });

  test('reads legacy key via canonical key mapping', () => {
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    });
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(false);
  });

  test('assistantFeatureFlagValues takes priority over legacy', () => {
    const config = {
      ...makeConfig({ featureFlags: { [DECLARED_LEGACY_KEY]: false } }),
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    } as AssistantConfig;
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test('ignores persisted values for undeclared keys', () => {
    const config = makeConfig({
      featureFlags: { 'skills.browser.enabled': false },
      assistantFeatureFlagValues: { 'feature_flags.browser.enabled': false },
    });
    expect(isAssistantFeatureFlagEnabled('feature_flags.browser.enabled', config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — feature flag filtering
// ---------------------------------------------------------------------------

describe('resolveSkillStates with feature flags', () => {
  test('flag OFF skill does not appear in resolved list', () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID), makeSkill('twitter')];
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).not.toContain(DECLARED_SKILL_ID);
    expect(ids).toContain('twitter');
  });

  test('flag ON skill appears normally', () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID), makeSkill('twitter')];
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: true, 'skills.twitter.enabled': true },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toContain(DECLARED_SKILL_ID);
    expect(ids).toContain('twitter');
  });

  test('missing flag key defaults to enabled', () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID)];
    const config = makeConfig({ featureFlags: {} });

    const resolved = resolveSkillStates(catalog, config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe(DECLARED_SKILL_ID);
  });

  test('feature flag OFF takes precedence over user-enabled config entry', () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID)];
    const config = makeConfig({
      featureFlags: { [DECLARED_LEGACY_KEY]: false },
      skills: {
        entries: { [DECLARED_SKILL_ID]: { enabled: true } },
        load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
        install: { nodeManager: 'npm' },
        allowBundled: null,
        remoteProviders: { skillssh: { enabled: true }, clawhub: { enabled: true } },
        remotePolicy: { blockSuspicious: true, blockMalware: true, maxSkillsShRisk: 'medium' },
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    // The skill should not appear at all — feature flag is a higher-priority gate
    expect(resolved.length).toBe(0);
  });

  test('multiple skills with mixed flags', () => {
    const catalog = [
      makeSkill(DECLARED_SKILL_ID),
      makeSkill('twitter'),
      makeSkill('deploy'),
    ];
    const config = makeConfig({
      featureFlags: {
        [DECLARED_LEGACY_KEY]: false,
        'skills.deploy.enabled': false,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toEqual(['twitter', 'deploy']);
  });
});
