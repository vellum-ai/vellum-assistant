import { describe, expect, test } from "bun:test";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import type { SkillSummary } from "../skills/catalog.js";
import { resolveSkillStates, skillFlagKey } from "../skills/skill-state.js";

const DECLARED_FLAG_KEY = "feature_flags.hatch-new-assistant.enabled";
const DECLARED_SKILL_ID = "hatch-new-assistant";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AssistantConfig with optional feature flag values. */
function makeConfig(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    skills: {
      entries: {},
      load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
    ...overrides,
  } as AssistantConfig;
}

/** Create a minimal SkillSummary for testing. */
function makeSkill(
  id: string,
  source: "bundled" | "managed" = "bundled",
): SkillSummary {
  return {
    id,
    name: `${id} skill`,
    displayName: `${id} skill`,
    description: `Description for ${id}`,
    directoryPath: `/fake/skills/${id}`,
    skillFilePath: `/fake/skills/${id}/SKILL.md`,
    bundled: source === "bundled",
    userInvocable: true,
    disableModelInvocation: false,
    source,
  };
}

// ---------------------------------------------------------------------------
// isAssistantFeatureFlagEnabled with skillFlagKey (canonical path)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled with skillFlagKey", () => {
  test("returns false when no flag overrides (registry default is false)", () => {
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled(skillFlagKey(DECLARED_SKILL_ID), config),
    ).toBe(false);
  });

  test("returns true when skill key is explicitly true", () => {
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    });
    expect(
      isAssistantFeatureFlagEnabled(skillFlagKey(DECLARED_SKILL_ID), config),
    ).toBe(true);
  });

  test("returns false when skill key is explicitly false", () => {
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    });
    expect(
      isAssistantFeatureFlagEnabled(skillFlagKey(DECLARED_SKILL_ID), config),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAssistantFeatureFlagEnabled (full canonical key)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled", () => {
  test("returns true for unknown flags (open by default)", () => {
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled("feature_flags.unknown.enabled", config),
    ).toBe(true);
  });

  test("assistantFeatureFlagValues overrides registry default", () => {
    const config = {
      ...makeConfig(),
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    } as AssistantConfig;
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("falls back to registry default when no override", () => {
    const config = makeConfig();
    // hatch-new-assistant defaults to false in the registry
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("respects persisted overrides for undeclared keys", () => {
    const config = makeConfig({
      assistantFeatureFlagValues: { "feature_flags.browser.enabled": false },
    });
    expect(
      isAssistantFeatureFlagEnabled("feature_flags.browser.enabled", config),
    ).toBe(false);
  });

  test("declared keys with no persisted override use registry default", () => {
    const config = makeConfig();
    // browser is declared in the registry with defaultEnabled: true
    expect(
      isAssistantFeatureFlagEnabled("feature_flags.browser.enabled", config),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — feature flag filtering
// ---------------------------------------------------------------------------

describe("resolveSkillStates with feature flags", () => {
  test("flag OFF skill does not appear in resolved list", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID), makeSkill("twitter")];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.twitter.enabled": true,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).not.toContain(DECLARED_SKILL_ID);
    expect(ids).toContain("twitter");
  });

  test("flag ON skill appears normally", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID), makeSkill("twitter")];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: true,
        "feature_flags.twitter.enabled": true,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toContain(DECLARED_SKILL_ID);
    expect(ids).toContain("twitter");
  });

  test("declared flag key defaults to registry value (false)", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID)];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    // hatch-new-assistant registry default is false, so it's filtered out
    expect(resolved.length).toBe(0);
  });

  test("feature flag OFF takes precedence over user-enabled config entry", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID)];
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
      skills: {
        entries: { [DECLARED_SKILL_ID]: { enabled: true } },
        load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
        install: { nodeManager: "npm" },
        allowBundled: null,
        remoteProviders: {
          skillssh: { enabled: true },
          clawhub: { enabled: true },
        },
        remotePolicy: {
          blockSuspicious: true,
          blockMalware: true,
          maxSkillsShRisk: "medium",
        },
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    // The skill should not appear at all — feature flag is a higher-priority gate
    expect(resolved.length).toBe(0);
  });

  test("multiple skills with mixed flags — persisted overrides respected", () => {
    const catalog = [
      makeSkill(DECLARED_SKILL_ID),
      makeSkill("twitter"),
      makeSkill("deploy"),
    ];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.twitter.enabled": true,
        "feature_flags.deploy.enabled": false,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // hatch-new-assistant and deploy explicitly false; twitter explicitly true
    expect(ids).toEqual(["twitter"]);
  });
});
