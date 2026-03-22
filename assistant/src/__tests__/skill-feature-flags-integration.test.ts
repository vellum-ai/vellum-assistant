/**
 * Integration test: end-to-end frontmatter parsing → feature flag resolution.
 *
 * Creates a SKILL.md with a `feature-flag` field in its YAML metadata,
 * parses it via the real frontmatter parser, and verifies that `skillFlagKey()`
 * returns the correct key and `resolveSkillStates()` correctly gates the skill.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _setOverridesForTesting,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";

beforeEach(() => {
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});
import type { AssistantConfig } from "../config/schema.js";
import { resolveSkillStates, skillFlagKey } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";
import { parseFrontmatterFields } from "../skills/frontmatter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A SKILL.md with `feature-flag: contacts` declared in its vellum metadata. */
const SKILL_MD_WITH_FLAG = `---
name: "Contacts"
description: "View and manage contacts"
metadata:
  vellum:
    feature-flag: contacts
---

Instructions for the contacts skill.
`;

/** A SKILL.md with no feature-flag field at all. */
const SKILL_MD_WITHOUT_FLAG = `---
name: "Plain Skill"
description: "A skill with no feature flag"
metadata:
  vellum: {}
---

Instructions for the plain skill.
`;

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

/**
 * Build a SkillSummary from parsed frontmatter, mimicking what the real
 * skill catalog loader does.
 */
function buildSkillSummary(
  id: string,
  skillMd: string,
  source: "bundled" | "managed" = "bundled",
): SkillSummary | null {
  const parsed = parseFrontmatterFields(skillMd);
  if (!parsed) return null;

  let featureFlag: string | undefined;
  const metadataObj = parsed.fields.metadata;
  if (metadataObj != null && typeof metadataObj === "object") {
    const vellum = (metadataObj as Record<string, unknown>).vellum as
      | Record<string, unknown>
      | undefined;
    featureFlag =
      typeof vellum?.["feature-flag"] === "string"
        ? vellum["feature-flag"]
        : undefined;
  }

  return {
    id,
    name: (parsed.fields.name as string) ?? id,
    displayName: (parsed.fields.name as string) ?? id,
    description: (parsed.fields.description as string) ?? "",
    directoryPath: `/fake/skills/${id}`,
    skillFilePath: `/fake/skills/${id}/SKILL.md`,
    bundled: source === "bundled",

    source,
    featureFlag,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("frontmatter feature-flag integration", () => {
  test("parses feature-flag from frontmatter YAML metadata", () => {
    const parsed = parseFrontmatterFields(SKILL_MD_WITH_FLAG);
    expect(parsed).not.toBeNull();

    const metadataObj = parsed!.fields.metadata as Record<string, unknown>;
    expect(metadataObj).toBeTruthy();

    const vellum = metadataObj.vellum as Record<string, unknown>;
    expect(vellum["feature-flag"]).toBe("contacts");
  });

  test("skillFlagKey returns correct key for parsed skill", () => {
    const skill = buildSkillSummary("contacts", SKILL_MD_WITH_FLAG);
    expect(skill).not.toBeNull();
    expect(skill!.featureFlag).toBe("contacts");

    const key = skillFlagKey(skill!);
    expect(key).toBe("feature_flags.contacts.enabled");
  });

  test("skillFlagKey returns undefined for skill without feature-flag", () => {
    const skill = buildSkillSummary("plain-skill", SKILL_MD_WITHOUT_FLAG);
    expect(skill).not.toBeNull();
    expect(skill!.featureFlag).toBeUndefined();

    const key = skillFlagKey(skill!);
    expect(key).toBeUndefined();
  });

  test("resolveSkillStates includes skill with featureFlag when flag defaults to ON", () => {
    const skill = buildSkillSummary("contacts", SKILL_MD_WITH_FLAG)!;
    // "contacts" is in the registry with defaultEnabled: true
    const config = makeConfig();

    const resolved = resolveSkillStates([skill], config);
    // Flag defaults to true → skill passes through
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe("contacts");
  });

  test("resolveSkillStates includes skill with featureFlag when flag is ON", () => {
    _setOverridesForTesting({
      "feature_flags.contacts.enabled": true,
    });
    const skill = buildSkillSummary("contacts", SKILL_MD_WITH_FLAG)!;
    const config = makeConfig();

    const resolved = resolveSkillStates([skill], config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe("contacts");
  });

  test("resolveSkillStates never gates skill without featureFlag", () => {
    const skill = buildSkillSummary("plain-skill", SKILL_MD_WITHOUT_FLAG)!;
    // Even with an explicit false override for this skill ID, it should pass through
    _setOverridesForTesting({
      "feature_flags.plain-skill.enabled": false,
    });
    const config = makeConfig();

    const resolved = resolveSkillStates([skill], config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe("plain-skill");
  });

  test("end-to-end: parse frontmatter → skillFlagKey → flag check → resolveSkillStates", () => {
    // Step 1: Parse SKILL.md with feature-flag in metadata
    const parsed = parseFrontmatterFields(SKILL_MD_WITH_FLAG);
    expect(parsed).not.toBeNull();
    const metadataObj = parsed!.fields.metadata as Record<string, unknown>;
    const vellum = metadataObj.vellum as Record<string, unknown>;
    const flagId = vellum["feature-flag"];
    expect(flagId).toBe("contacts");

    // Step 2: Build SkillSummary (as the catalog loader would)
    const skill = buildSkillSummary("contacts", SKILL_MD_WITH_FLAG)!;
    expect(skill.featureFlag).toBe("contacts");

    // Step 3: Derive the flag key
    const key = skillFlagKey(skill);
    expect(key).toBe("feature_flags.contacts.enabled");

    // Step 4: Check flag state — "contacts" has defaultEnabled: true in registry
    const configDefault = makeConfig();
    expect(isAssistantFeatureFlagEnabled(key!, configDefault)).toBe(true);

    // Step 5: resolveSkillStates includes it by default
    const resolvedDefault = resolveSkillStates([skill], configDefault);
    expect(resolvedDefault.length).toBe(1);
    expect(resolvedDefault[0].summary.id).toBe("contacts");

    // Step 6: With override disabled, skill is filtered out
    _setOverridesForTesting({ [key!]: false });
    const configOff = makeConfig();
    expect(isAssistantFeatureFlagEnabled(key!, configOff)).toBe(false);

    const resolvedOff = resolveSkillStates([skill], configOff);
    expect(resolvedOff.length).toBe(0);
  });
});
