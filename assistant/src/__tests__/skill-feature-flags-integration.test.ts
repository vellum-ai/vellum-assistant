/**
 * Integration test: end-to-end frontmatter parsing → feature flag resolution.
 *
 * Creates a SKILL.md with a `feature-flag` field in its YAML metadata,
 * parses it via the real frontmatter parser, and verifies that `skillFlagKey()`
 * returns the correct key and `resolveSkillStates()` correctly gates the skill.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});
import type { AssistantConfig } from "../config/schema.js";
import { resolveSkillStates, skillFlagKey } from "../config/skill-state.js";
import type { SkillSummary } from "../config/skills.js";
import { parseFrontmatterFields } from "../skills/frontmatter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A SKILL.md with `feature-flag: a2a-channel` declared in its vellum metadata. */
const SKILL_MD_WITH_FLAG = `---
name: "Email Setup"
description: "Set up email integration"
metadata:
  vellum:
    feature-flag: a2a-channel
---

Instructions for the email setup skill.
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
    expect(vellum["feature-flag"]).toBe("a2a-channel");
  });

  test("skillFlagKey returns correct key for parsed skill", () => {
    const skill = buildSkillSummary("email-setup", SKILL_MD_WITH_FLAG);
    expect(skill).not.toBeNull();
    expect(skill!.featureFlag).toBe("a2a-channel");

    const key = skillFlagKey(skill!);
    expect(key).toBe("a2a-channel");
  });

  test("skillFlagKey returns undefined for skill without feature-flag", () => {
    const skill = buildSkillSummary("plain-skill", SKILL_MD_WITHOUT_FLAG);
    expect(skill).not.toBeNull();
    expect(skill!.featureFlag).toBeUndefined();

    const key = skillFlagKey(skill!);
    expect(key).toBeUndefined();
  });

  test("resolveSkillStates includes skill with featureFlag when flag is ON", () => {
    setOverridesForTesting({
      "a2a-channel": true,
    });
    const skill = buildSkillSummary("email-setup", SKILL_MD_WITH_FLAG)!;
    const config = makeConfig();

    const resolved = resolveSkillStates([skill], config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe("email-setup");
  });

  test("resolveSkillStates excludes skill with featureFlag when flag defaults to OFF", () => {
    const skill = buildSkillSummary("email-setup", SKILL_MD_WITH_FLAG)!;
    // "a2a-channel" is in the registry with defaultEnabled: false
    const config = makeConfig();

    const resolved = resolveSkillStates([skill], config);
    // Flag defaults to false → skill is filtered out
    expect(resolved.length).toBe(0);
  });

  test("resolveSkillStates never gates skill without featureFlag", () => {
    const skill = buildSkillSummary("plain-skill", SKILL_MD_WITHOUT_FLAG)!;
    // Even with an explicit false override for this skill ID, it should pass through
    setOverridesForTesting({
      "plain-skill": false,
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
    expect(flagId).toBe("a2a-channel");

    // Step 2: Build SkillSummary (as the catalog loader would)
    const skill = buildSkillSummary("email-setup", SKILL_MD_WITH_FLAG)!;
    expect(skill.featureFlag).toBe("a2a-channel");

    // Step 3: Derive the flag key
    const key = skillFlagKey(skill);
    expect(key).toBe("a2a-channel");

    // Step 4: Check flag state — "a2a-channel" has defaultEnabled: false in registry
    const configDefault = makeConfig();
    expect(isAssistantFeatureFlagEnabled(key!, configDefault)).toBe(false);

    // Step 5: resolveSkillStates excludes it by default (flag is off)
    const resolvedDefault = resolveSkillStates([skill], configDefault);
    expect(resolvedDefault.length).toBe(0);

    // Step 6: With override enabled, skill passes through
    setOverridesForTesting({ [key!]: true });
    const configOn = makeConfig();
    expect(isAssistantFeatureFlagEnabled(key!, configOn)).toBe(true);

    const resolvedOn = resolveSkillStates([skill], configOn);
    expect(resolvedOn.length).toBe(1);
    expect(resolvedOn[0].summary.id).toBe("email-setup");

    // Step 7: With override disabled, skill is filtered out
    setOverridesForTesting({ [key!]: false });
    const configOff = makeConfig();
    expect(isAssistantFeatureFlagEnabled(key!, configOff)).toBe(false);

    const resolvedOff = resolveSkillStates([skill], configOff);
    expect(resolvedOff.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bundled ACP skill: discoverability when ACP is disabled
// ---------------------------------------------------------------------------

describe("bundled acp skill discoverability", () => {
  test("acp skill resolves with no frontmatter flag gate", () => {
    // The ACP skill carries its own first-time-setup instructions and is
    // always discoverable: it has no frontmatter feature-flag gate.
    const skillMdPath = fileURLToPath(
      new URL("../config/bundled-skills/acp/SKILL.md", import.meta.url),
    );
    const skillMd = readFileSync(skillMdPath, "utf8");

    const skill = buildSkillSummary("acp", skillMd);
    expect(skill).not.toBeNull();
    expect(skill!.featureFlag).toBeUndefined();
    expect(skillFlagKey(skill!)).toBeUndefined();

    const config = makeConfig({
      acp: { maxConcurrentSessions: 4, agents: {} },
    });

    const resolved = resolveSkillStates([skill!], config);
    expect(resolved.length).toBe(1);
    expect(resolved[0].summary.id).toBe("acp");
    expect(resolved[0].state).toBe("enabled");
  });
});
