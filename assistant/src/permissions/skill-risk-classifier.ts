/**
 * Skill risk classifier — classifies skill tool invocations by risk level.
 *
 * Implements RiskClassifier<SkillClassifierInput> with constant risk levels
 * for each skill tool type:
 * - skill_load: Low (read-only skill loading)
 * - scaffold_managed_skill: High (writes persistent skill source code)
 * - delete_managed_skill: High (removes persistent skill source code)
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { loadSkillCatalog, resolveSkillSelector } from "../config/skills.js";
import { indexCatalogById } from "../skills/include-graph.js";
import { computeTransitiveSkillVersionHash } from "../skills/transitive-version-hash.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { RiskAssessment, RiskClassifier } from "./risk-types.js";
import type { AllowlistOption } from "./types.js";

// ── Input type ───────────────────────────────────────────────────────────────

/** Input to the skill risk classifier. */
export interface SkillClassifierInput {
  /** Which skill tool is being invoked. */
  toolName: "skill_load" | "scaffold_managed_skill" | "delete_managed_skill";
  /** Optional skill selector (e.g. skill name or path). */
  skillSelector?: string;
}

// ── Allowlist option helpers ─────────────────────────────────────────────────

/**
 * Resolve a skill selector to its id and version hash. The version hash
 * is always computed from disk so that untrusted input cannot spoof a
 * pre-approved hash.
 */
function resolveSkillIdAndHash(
  selector: string,
): { id: string; versionHash?: string } | null {
  const resolved = resolveSkillSelector(selector);
  if (!resolved.skill) return null;

  try {
    const hash = computeSkillVersionHash(resolved.skill.directoryPath);
    return { id: resolved.skill.id, versionHash: hash };
  } catch {
    return { id: resolved.skill.id };
  }
}

/**
 * Check whether a skill (by id) has parsed inline command expansions.
 */
function hasInlineExpansions(skillId: string): boolean {
  const catalog = loadSkillCatalog();
  const skill = catalog.find((s) => s.id === skillId);
  return (
    skill?.inlineCommandExpansions != null &&
    skill.inlineCommandExpansions.length > 0
  );
}

/**
 * Compute the transitive version hash for a skill, returning `undefined`
 * when computation fails (missing includes, cycle, etc.).
 */
function computeTransitiveHashSafe(skillId: string): string | undefined {
  try {
    const catalog = loadSkillCatalog();
    const index = indexCatalogById(catalog);
    return computeTransitiveSkillVersionHash(skillId, index);
  } catch {
    return undefined;
  }
}

/**
 * Build allowlist options for a skill_load invocation, mirroring the logic
 * in checker.ts `skillLoadAllowlistStrategy()`.
 */
function buildSkillLoadAllowlistOptions(
  rawSelector?: string,
): AllowlistOption[] {
  if (!rawSelector) {
    return [
      {
        label: "skill_load:*",
        description: "All skill loads",
        pattern: "skill_load:*",
      },
    ];
  }

  const resolved = resolveSkillIdAndHash(rawSelector);

  // Check whether this is a dynamic (inline-command) skill load
  const config = getConfig();
  const inlineEnabled = isAssistantFeatureFlagEnabled(
    "inline-skill-commands",
    config,
  );

  if (resolved && inlineEnabled && hasInlineExpansions(resolved.id)) {
    const transitiveHash = computeTransitiveHashSafe(resolved.id);
    const options: AllowlistOption[] = [];
    if (transitiveHash) {
      options.push({
        label: `${resolved.id}@${transitiveHash}`,
        description: "This exact version (pinned)",
        pattern: `skill_load_dynamic:${resolved.id}@${transitiveHash}`,
      });
    }
    options.push({
      label: resolved.id,
      description: "This skill (any version)",
      pattern: `skill_load_dynamic:${resolved.id}`,
    });
    return options;
  }

  if (resolved && resolved.versionHash) {
    return [
      {
        label: `${resolved.id}@${resolved.versionHash}`,
        description: "This exact version",
        pattern: `skill_load:${resolved.id}@${resolved.versionHash}`,
      },
    ];
  }
  return [
    {
      label: rawSelector,
      description: "This skill",
      pattern: `skill_load:${rawSelector}`,
    },
  ];
}

/**
 * Build allowlist options for scaffold/delete managed skill tools,
 * mirroring the logic in checker.ts `managedSkillAllowlistStrategy()`.
 */
function buildManagedSkillAllowlistOptions(
  toolName: string,
  skillId?: string,
): AllowlistOption[] {
  const toolLabel =
    toolName === "scaffold_managed_skill" ? "scaffold" : "delete";
  const options: AllowlistOption[] = [];
  if (skillId) {
    options.push({
      label: skillId,
      description: "This skill only",
      pattern: `${toolName}:${skillId}`,
    });
  }
  options.push({
    label: `${toolName}:*`,
    description: `All managed skill ${toolLabel}s`,
    pattern: `${toolName}:*`,
  });
  return options;
}

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Skill risk classifier implementation.
 *
 * Classifies skill tool invocations with constant risk levels per tool type.
 * checker.ts delegates to the singleton `skillLoadRiskClassifier` instance
 * for all skill tool risk classification.
 */
export class SkillLoadRiskClassifier implements RiskClassifier<SkillClassifierInput> {
  async classify(input: SkillClassifierInput): Promise<RiskAssessment> {
    const { toolName, skillSelector } = input;

    switch (toolName) {
      case "skill_load":
        return {
          riskLevel: "low",
          reason: "Skill load (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildSkillLoadAllowlistOptions(skillSelector),
        };
      case "scaffold_managed_skill":
        return {
          riskLevel: "high",
          reason: "Skill scaffold — writes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildManagedSkillAllowlistOptions(
            toolName,
            skillSelector,
          ),
        };
      case "delete_managed_skill":
        return {
          riskLevel: "high",
          reason: "Skill delete — removes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildManagedSkillAllowlistOptions(
            toolName,
            skillSelector,
          ),
        };
    }
  }
}

/** Singleton classifier instance. */
export const skillLoadRiskClassifier = new SkillLoadRiskClassifier();
