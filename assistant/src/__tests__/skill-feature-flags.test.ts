import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  isSkillFeatureFlagEnabled,
  resolveSkillStates,
  skillFlagKey,
} from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

const DECLARED_FLAG_ID = "a2a-channel";
const DECLARED_FLAG_KEY = DECLARED_FLAG_ID;
const DECLARED_SKILL_ID = "a2a-channel";
const ENABLED_UNDECLARED_FLAG_KEY = "enabled-undeclared-flag";
const ENABLED_UNDECLARED_SKILL_ID = "enabled-undeclared-skill";
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
    expect(skillFlagKey({ featureFlag: "my-flag" })).toBe("my-flag");
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
  test("returns false when no flag overrides (registry default is false)", () => {
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });

  test("returns true when skill key is explicitly true", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });
    const config = makeConfig();
    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(true);
  });

  test("returns false when skill key is explicitly false", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = makeConfig();
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
  test("returns false for unknown flags (closed by default)", () => {
    const config = makeConfig();
    expect(isAssistantFeatureFlagEnabled("unknown", config)).toBe(false);
  });

  test("file-based override overrides registry default", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const config = makeConfig();
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("falls back to registry default when no override", () => {
    const config = makeConfig();
    // a2a-channel defaults to false in the registry
    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("respects persisted overrides for undeclared keys", () => {
    setOverridesForTesting({ "some-undeclared-flag": false });
    const config = makeConfig();
    expect(isAssistantFeatureFlagEnabled("some-undeclared-flag", config)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — feature flag filtering
// ---------------------------------------------------------------------------

describe("resolveSkillStates with feature flags", () => {
  test("flag OFF skill does not appear in resolved list", () => {
    setOverridesForTesting({
      [DECLARED_FLAG_KEY]: false,
      [ENABLED_UNDECLARED_FLAG_KEY]: true,
    });
    const catalog = [
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill(
        ENABLED_UNDECLARED_SKILL_ID,
        "bundled",
        ENABLED_UNDECLARED_FLAG_KEY,
      ),
    ];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).not.toContain(DECLARED_SKILL_ID);
    expect(ids).toContain(ENABLED_UNDECLARED_SKILL_ID);
  });

  test("flag ON skill appears normally", () => {
    setOverridesForTesting({
      [DECLARED_FLAG_KEY]: true,
      [ENABLED_UNDECLARED_FLAG_KEY]: true,
    });
    const catalog = [
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill(
        ENABLED_UNDECLARED_SKILL_ID,
        "bundled",
        ENABLED_UNDECLARED_FLAG_KEY,
      ),
    ];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    expect(ids).toContain(DECLARED_SKILL_ID);
    expect(ids).toContain(ENABLED_UNDECLARED_SKILL_ID);
  });

  test("declared flag key defaults to registry value (false)", () => {
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    // a2a-channel registry default is false, so it is filtered out
    expect(resolved.length).toBe(0);
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
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig({
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
    setOverridesForTesting({
      [DECLARED_FLAG_KEY]: false,
      [ENABLED_UNDECLARED_FLAG_KEY]: true,
      deploy: false,
    });
    const catalog = [
      makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID),
      makeSkill(
        ENABLED_UNDECLARED_SKILL_ID,
        "bundled",
        ENABLED_UNDECLARED_FLAG_KEY,
      ),
      makeSkill("deploy", "bundled", "deploy"),
    ];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // a2a-channel and deploy explicitly false; one unrelated skill explicitly true
    expect(ids).toEqual([ENABLED_UNDECLARED_SKILL_ID]);
  });
});

// ---------------------------------------------------------------------------
// Per-flag predicate overrides (config-aware gating)
// ---------------------------------------------------------------------------

describe("skill flag predicate overrides (acp)", () => {
  /** Config with the `acp` section the ACP gate reads. */
  function makeAcpConfig(acpEnabled: boolean): AssistantConfig {
    return makeConfig({
      acp: { enabled: acpEnabled, maxConcurrentSessions: 4, agents: {} },
    } as Partial<AssistantConfig>);
  }

  test("isSkillFeatureFlagEnabled: acp flag routes through isAcpEnabled (config-on, flag-off)", () => {
    // Flag at registry default (false), but config.acp.enabled is true:
    // the OR semantics must keep the gate open.
    expect(isSkillFeatureFlagEnabled("acp", makeAcpConfig(true))).toBe(true);
  });

  test("isSkillFeatureFlagEnabled: acp gate closed when both flag and config are off", () => {
    expect(isSkillFeatureFlagEnabled("acp", makeAcpConfig(false))).toBe(false);
  });

  test("isSkillFeatureFlagEnabled: acp gate open when flag is on and config is off", () => {
    setOverridesForTesting({ acp: true });
    expect(isSkillFeatureFlagEnabled("acp", makeAcpConfig(false))).toBe(true);
  });

  test("isSkillFeatureFlagEnabled: non-overridden flags fall back to the flag resolver", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });
    expect(
      isSkillFeatureFlagEnabled(DECLARED_FLAG_KEY, makeAcpConfig(false)),
    ).toBe(true);
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });
    expect(
      isSkillFeatureFlagEnabled(DECLARED_FLAG_KEY, makeAcpConfig(true)),
    ).toBe(false);
  });

  test("resolveSkillStates keeps the ACP skill when config.acp.enabled is true and the flag is off", () => {
    const catalog = [makeSkill("acp", "bundled", "acp")];

    const resolved = resolveSkillStates(catalog, makeAcpConfig(true));
    const ids = resolved.map((r) => r.summary.id);
    expect(ids).toContain("acp");
  });

  test("resolveSkillStates drops the ACP skill when both the flag and config.acp.enabled are off", () => {
    const catalog = [makeSkill("acp", "bundled", "acp")];

    const resolved = resolveSkillStates(catalog, makeAcpConfig(false));
    expect(resolved.length).toBe(0);
  });

  test("resolveSkillStates keeps the ACP skill when the flag is on and config.acp.enabled is off", () => {
    setOverridesForTesting({ acp: true });
    const catalog = [makeSkill("acp", "bundled", "acp")];

    const resolved = resolveSkillStates(catalog, makeAcpConfig(false));
    const ids = resolved.map((r) => r.summary.id);
    expect(ids).toContain("acp");
  });

  test("explicit acp flag-off override does not defeat config.acp.enabled", () => {
    setOverridesForTesting({ acp: false });
    const catalog = [makeSkill("acp", "bundled", "acp")];

    const resolved = resolveSkillStates(catalog, makeAcpConfig(true));
    const ids = resolved.map((r) => r.summary.id);
    expect(ids).toContain("acp");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillStates — frontmatter featureFlag gating
// ---------------------------------------------------------------------------

describe("resolveSkillStates with frontmatter featureFlag", () => {
  test("skill with featureFlag (defaultEnabled: false) is excluded when no config override", () => {
    // a2a-channel has defaultEnabled: false in the registry
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    // No override, registry default is false → filtered out
    expect(resolved.length).toBe(0);
  });

  test("skill with featureFlag is included when override enables it", () => {
    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });
    const catalog = [makeSkill(DECLARED_SKILL_ID, "bundled", DECLARED_FLAG_ID)];
    const config = makeConfig();

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
    setOverridesForTesting({
      "my-skill": false,
    });
    const catalog = [makeSkill("my-skill")];
    const config = makeConfig();

    const resolved = resolveSkillStates(catalog, config);
    const ids = resolved.map((r) => r.summary.id);

    // The skill has no featureFlag field, so it is never gated
    expect(ids).toContain("my-skill");
  });
});
