/**
 * Skill risk classifier — classifies skill tool invocations by risk level.
 *
 * Implements RiskClassifier<SkillClassifierInput> with constant risk levels
 * for each skill tool type:
 * - skill_load: Low (read-only skill loading)
 * - scaffold_managed_skill: High (writes persistent skill source code)
 * - delete_managed_skill: High (removes persistent skill source code)
 *
 * Gateway adaptation: accepts pre-resolved skill metadata via
 * SkillClassifierInput.resolvedMetadata instead of importing the assistant's
 * skill catalog, version hash utilities, and feature flags. The assistant is
 * responsible for resolving metadata before calling the classifier via IPC.
 */

import type {
  AllowlistOption,
  RiskAssessment,
  RiskClassifier,
} from "./risk-types.js";
import { getTrustRuleCache } from "./trust-rule-cache.js";

// -- Input type ---------------------------------------------------------------

/**
 * Pre-resolved skill metadata provided by the assistant. Replaces the
 * assistant-internal calls to resolveSkillSelector, computeSkillVersionHash,
 * computeTransitiveSkillVersionHash, loadSkillCatalog, indexCatalogById,
 * getConfig, and isAssistantFeatureFlagEnabled.
 */
export interface ResolvedSkillMetadata {
  /** Canonical skill identifier (e.g. "my-skill"). */
  skillId: string;
  /** The raw selector the user provided (may differ from skillId). */
  selector: string;
  /** Direct version hash of the skill, if computable. */
  versionHash: string;
  /** Transitive version hash (includes includes), if computable. */
  transitiveHash?: string;
  /** Whether the skill has parsed inline command expansions. */
  hasInlineExpansions: boolean;
  /**
   * Whether this is a "dynamic" skill load (inline-skill-commands feature
   * flag is enabled AND the skill has inline command expansions).
   */
  isDynamic: boolean;
}

/** Input to the skill risk classifier. */
export interface SkillClassifierInput {
  /** Which skill tool is being invoked. */
  toolName: "skill_load" | "scaffold_managed_skill" | "delete_managed_skill";
  /** Optional skill selector (e.g. skill name or path). */
  skillSelector?: string;
  /**
   * Pre-resolved skill metadata. When present, the classifier uses this
   * directly instead of loading the skill catalog. When absent, the
   * classifier falls back to basic selector-based options.
   */
  resolvedMetadata?: ResolvedSkillMetadata;
}

// -- Allowlist option helpers -------------------------------------------------

/**
 * Build allowlist options for a skill_load invocation using pre-resolved
 * metadata.
 */
function buildSkillLoadAllowlistOptions(
  rawSelector?: string,
  metadata?: ResolvedSkillMetadata,
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

  // If no metadata was resolved, fall back to a basic selector-based option
  if (!metadata) {
    return [
      {
        label: rawSelector,
        description: "This skill",
        pattern: `skill_load:${rawSelector}`,
      },
    ];
  }

  // Dynamic skill (inline command expansions + feature flag enabled)
  if (metadata.isDynamic && metadata.hasInlineExpansions) {
    const options: AllowlistOption[] = [];
    if (metadata.transitiveHash) {
      options.push({
        label: `${metadata.skillId}@${metadata.transitiveHash}`,
        description: "This exact version (pinned)",
        pattern: `skill_load_dynamic:${metadata.skillId}@${metadata.transitiveHash}`,
      });
    }
    options.push({
      label: metadata.skillId,
      description: "This skill (any version)",
      pattern: `skill_load_dynamic:${metadata.skillId}`,
    });
    return options;
  }

  // Regular skill with version hash — version-pinned option
  if (metadata.versionHash) {
    return [
      {
        label: `${metadata.skillId}@${metadata.versionHash}`,
        description: "This exact version",
        pattern: `skill_load:${metadata.skillId}@${metadata.versionHash}`,
      },
    ];
  }

  // Fallback: no hash available
  return [
    {
      label: rawSelector,
      description: "This skill",
      pattern: `skill_load:${rawSelector}`,
    },
  ];
}

/**
 * Build allowlist options for scaffold/delete managed skill tools.
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

// -- Classifier ---------------------------------------------------------------

/**
 * Skill risk classifier implementation.
 *
 * Classifies skill tool invocations with constant risk levels per tool type.
 * Uses pre-resolved metadata (when available) to build allowlist options,
 * eliminating all assistant-specific imports.
 */
export class SkillLoadRiskClassifier implements RiskClassifier<SkillClassifierInput> {
  async classify(input: SkillClassifierInput): Promise<RiskAssessment> {
    const { toolName, skillSelector, resolvedMetadata } = input;

    // Run normal classification first, then check for user overrides at
    // the end. Note that user overrides are applied unconditionally, so a
    // user-defined rule CAN lower a security-escalated risk. This is
    // intentional — user overrides are authoritative for users who
    // explicitly created them.
    let assessment: RiskAssessment;

    switch (toolName) {
      case "skill_load":
        assessment = {
          riskLevel: "low",
          reason: "Skill load (default)",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildSkillLoadAllowlistOptions(
            skillSelector,
            resolvedMetadata,
          ),
        };
        break;
      case "scaffold_managed_skill":
        assessment = {
          riskLevel: "high",
          reason: "Skill scaffold — writes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildManagedSkillAllowlistOptions(
            toolName,
            skillSelector,
          ),
        };
        break;
      case "delete_managed_skill":
        assessment = {
          riskLevel: "high",
          reason: "Skill delete — removes persistent skill source code",
          scopeOptions: [],
          matchType: "registry",
          allowlistOptions: buildManagedSkillAllowlistOptions(
            toolName,
            skillSelector,
          ),
        };
        break;
    }

    // User override is applied after normal classification. This means a user-defined
    // rule CAN lower a security-escalated risk (e.g., scaffold_managed_skill).
    // This is intentional — user overrides are authoritative for users who explicitly
    // created them. Uses resolved skillId from metadata (when available), and
    // skill_load_dynamic as the tool key for dynamic skills.
    try {
      const ruleCache = getTrustRuleCache();
      const isDynamic =
        resolvedMetadata?.isDynamic && resolvedMetadata?.hasInlineExpansions;
      const overrideTool = isDynamic ? "skill_load_dynamic" : toolName;
      const overridePattern = resolvedMetadata?.skillId ?? skillSelector ?? "";
      const override = ruleCache.findToolOverride(
        overrideTool,
        overridePattern,
      );
      if (
        override &&
        (override.userModified || override.origin === "user_defined")
      ) {
        return {
          riskLevel: override.risk,
          reason: override.description,
          scopeOptions: [],
          matchType: "user_rule",
        };
      }
    } catch {
      // Cache not initialized — no override
    }

    return assessment!;
  }
}

/** Singleton classifier instance. */
export const skillLoadRiskClassifier = new SkillLoadRiskClassifier();
