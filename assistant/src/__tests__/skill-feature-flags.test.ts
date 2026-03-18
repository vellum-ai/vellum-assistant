import { describe, expect, test } from "bun:test";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { resolveSkillStates, skillFlagKey } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";

const DECLARED_FLAG_ID = "contacts";
const DECLARED_FLAG_KEY = `feature_flags.${DECLARED_FLAG_ID}.enabled`;
const DECLARED_SKILL_ID = "contacts";
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
  featureFlag?: string,
): SkillSummary {
  return {
    id,
    name: `${id} skill`,
    displayName: `${id} skill`,
    description: `Description for ${id}`,
    directoryPath: `/fake/skills/${id}`,
    skillFilePath: `/fake/skills/${id}/SKILL.md`,
    bundled: source === "bundled",

    source,
    featureFlag,
  };
}

// ---------------------------------------------------------------------------
// skillFlagKey — unit tests
// ---------------------------------------------------------------------------

describe("skillFlagKey", () => {
  test("returns canonical key when featureFlag is present", () => {
    expect(skillFlagKey({ featureFlag: "my-flag" })).toBe(
      "feature_flags.my-flag.enabled",
    );
  });

  test("returns undefined when featureFlag is undefined", () => {
    expect(skillFlagKey({ featureFlag: undefined })).toBeUndefined();
  });

  test("returns undefined when featureFlag field is absent", () => {
    expect(
      skillFlagKey({} as Pick<SkillSummary, "featureFlag">),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isAssistantFeatureFlagEnabled with skillFlagKey (canonical path)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled with skillFlagKey", () => {
  test("returns true when no flag overrides (registry default is true)", () => {
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(true);
  });

  test("returns true when skill key is explicitly true", () => {
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    });
    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(true);
  });

  test("returns false when skill key is explicitly false", () => {
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    });
    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
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
    // contacts defaults to true in the registry
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
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
    const catalog = [
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill("browser", "bundled", "browser"),
    ];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.browser.enabled": true,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).not.toContain(DECLARED_SKILL_ID);
    expect(ids).toContain("browser");
  });

  test("flag ON skill appears normally", () => {
    const catalog = [
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill("browser", "bundled", "browser"),
    ];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: true,
        "feature_flags.browser.enabled": true,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toContain(DECLARED_SKILL_ID);
    expect(ids).toContain("browser");
  });

  test("declared flag key defaults to registry value (true)", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    // contacts registry default is true, so it passes through
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe(DECLARED_SKILL_ID);
  });

  test("skill without featureFlag is never flag-gated", () => {
    const catalog = [makeSkill("no-flag-skill")];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // Skills without featureFlag are never gated — always pass through
    expect(ids).toContain("no-flag-skill");
  });

  test("feature flag OFF takes precedence over user-enabled config entry", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
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
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill("browser", "bundled", "browser"),
      makeSkill("deploy", "bundled", "deploy"),
    ];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.browser.enabled": true,
        "feature_flags.deploy.enabled": false,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // contacts and deploy explicitly false; browser explicitly true
    expect(ids).toEqual(["browser"]);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — frontmatter featureFlag gating
// ---------------------------------------------------------------------------

describe("resolveSkillStates with frontmatter featureFlag", () => {
  test("skill with featureFlag (defaultEnabled: true) is included when no config override", () => {
    // contacts has defaultEnabled: true in the registry
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    // No override, registry default is true → passes through
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe(DECLARED_SKILL_ID);
  });

  test("skill with featureFlag is included when config override enables it", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig({
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);
    expect(ids).toContain(DECLARED_SKILL_ID);
  });

  test("skill without featureFlag is NEVER filtered by the flag system", () => {
    const catalog = [makeSkill("no-flag-skill")];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // No featureFlag declared → always passes through regardless of any flags
    expect(ids).toContain("no-flag-skill");
  });

  test("skill without featureFlag passes through even when feature_flags.<skillId>.enabled is explicitly false", () => {
    // This proves the implicit skillId→flag mapping is gone:
    // setting feature_flags.my-skill.enabled = false has no effect
    // when the skill itself does not declare a featureFlag.
    const catalog = [makeSkill("my-skill")];
    const config = makeConfig({
      assistantFeatureFlagValues: {
        "feature_flags.my-skill.enabled": false,
      },
    });

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // The skill has no featureFlag field, so it is never gated
    expect(ids).toContain("my-skill");
  });
});
