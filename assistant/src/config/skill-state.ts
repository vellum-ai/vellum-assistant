import { ACP_FLAG_KEY, isAcpEnabled } from "../acp/feature-gate.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig, SkillEntryConfig } from "./schema.js";
import type { SkillSummary } from "./skills.js";

export type SkillState = "enabled" | "disabled";

/**
 * Per-flag predicate overrides for skill gating. Most skill feature flags are
 * resolved purely through the flag system, but some subsystems have richer
 * enablement semantics (e.g. ACP is flag OR `config.acp.enabled`). Routing the
 * skill gate through the subsystem's own feature gate keeps the skill
 * available whenever the subsystem itself is enabled.
 */
const SKILL_FLAG_PREDICATES: Record<
  string,
  (config: AssistantConfig) => boolean
> = {
  [ACP_FLAG_KEY]: isAcpEnabled,
};

/**
 * Whether the feature flag declared by a skill's frontmatter should be
 * considered enabled. Used by every skill flag-gating enforcement point so
 * that per-flag predicate overrides (see {@link SKILL_FLAG_PREDICATES}) apply
 * consistently everywhere.
 */
export function isSkillFeatureFlagEnabled(
  flagKey: string,
  config: AssistantConfig,
): boolean {
  const predicate = SKILL_FLAG_PREDICATES[flagKey];
  if (predicate) return predicate(config);
  return isAssistantFeatureFlagEnabled(flagKey, config);
}

export interface ResolvedSkill {
  summary: SkillSummary;
  state: SkillState;
  configEntry?: SkillEntryConfig;
}

/**
 * Derive the feature flag key for a skill from its frontmatter `featureFlag` field.
 * Returns undefined if the skill has no feature flag declared.
 */
export function skillFlagKey(
  skill: Pick<SkillSummary, "featureFlag">,
): string | undefined {
  return skill.featureFlag || undefined;
}

export function resolveSkillStates(
  catalog: SkillSummary[],
  config: AssistantConfig,
): ResolvedSkill[] {
  const results: ResolvedSkill[] = [];
  const { entries, allowBundled } = config.skills ?? {
    entries: {},
    allowBundled: null,
  };

  for (const skill of catalog) {
    // Assistant feature flag gate: if the skill declares a flag and it's disabled, skip it
    const flagKey = skillFlagKey(skill);
    if (flagKey && !isSkillFeatureFlagEnabled(flagKey, config)) {
      continue;
    }

    // Filter bundled skills by allowlist
    if (
      skill.source === "bundled" &&
      allowBundled != null &&
      !allowBundled.includes(skill.id)
    ) {
      continue;
    }

    const configKey = skill.id;
    const entry = entries[configKey];

    // Determine enabled state
    let isEnabled: boolean;
    if (entry && typeof entry.enabled === "boolean") {
      isEnabled = entry.enabled;
    } else {
      // Default: bundled, managed (user-installed), and plugin-contributed
      // skills are enabled. Others (workspace, extra) are disabled by default.
      isEnabled =
        skill.source === "bundled" ||
        skill.source === "managed" ||
        skill.source === "plugin";
    }

    if (!isEnabled) {
      results.push({
        summary: skill,
        state: "disabled",
        configEntry: entry,
      });
      continue;
    }

    results.push({
      summary: skill,
      state: "enabled",
      configEntry: entry,
    });
  }

  return results;
}
