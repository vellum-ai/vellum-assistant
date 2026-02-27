import { isAssistantSkillEnabled } from './assistant-feature-flags.js';
import type { AssistantConfig, SkillEntryConfig } from './schema.js';
import type { SkillSummary } from './skills.js';
import { checkSkillRequirements } from './skills.js';

export type SkillState = 'enabled' | 'disabled' | 'degraded' | 'available';

export interface ResolvedSkill {
  summary: SkillSummary;
  state: SkillState;
  degraded: boolean;
  missingRequirements?: { bins?: string[]; env?: string[] };
  configEntry?: SkillEntryConfig;
}

/**
 * @deprecated Use `isAssistantSkillEnabled` from `./assistant-feature-flags.js` instead.
 *
 * Thin backward-compatible wrapper that delegates to the canonical resolver.
 * Kept to avoid breaking existing call sites during migration.
 */
export function isSkillFeatureEnabled(skillId: string, config: AssistantConfig): boolean {
  return isAssistantSkillEnabled(skillId, config);
}

export function resolveSkillStates(
  catalog: SkillSummary[],
  config: AssistantConfig,
): ResolvedSkill[] {
  const results: ResolvedSkill[] = [];
  const { entries, allowBundled } = config.skills ?? { entries: {}, allowBundled: null };

  for (const skill of catalog) {
    // Assistant feature flag gate: if the flag is explicitly OFF, skip this skill entirely
    if (!isAssistantSkillEnabled(skill.id, config)) {
      continue;
    }

    // Filter bundled skills by allowlist
    if (skill.source === 'bundled' && allowBundled != null && !allowBundled.includes(skill.id)) {
      continue;
    }

    const configKey = skill.id;
    const entry = entries[configKey];

    // Determine enabled state
    let isEnabled: boolean;
    if (entry && typeof entry.enabled === 'boolean') {
      isEnabled = entry.enabled;
    } else {
      // Default: bundled and managed (user-installed) skills are enabled, others are disabled
      isEnabled = skill.source === 'bundled' || skill.source === 'managed';
    }

    if (!isEnabled) {
      results.push({
        summary: skill,
        state: 'disabled',
        degraded: false,
        configEntry: entry,
      });
      continue;
    }

    // Check requirements for enabled skills
    const envOverrides = buildEnvOverrides(skill, entry);
    const reqCheck = checkSkillRequirements(skill, envOverrides);

    if (!reqCheck.eligible) {
      results.push({
        summary: skill,
        state: 'degraded',
        degraded: true,
        missingRequirements: reqCheck.missing,
        configEntry: entry,
      });
    } else {
      results.push({
        summary: skill,
        state: 'enabled',
        degraded: false,
        configEntry: entry,
      });
    }
  }

  return results;
}

function buildEnvOverrides(
  skill: SkillSummary,
  entry?: SkillEntryConfig,
): Record<string, string> | undefined {
  if (!entry) return undefined;
  const overrides: Record<string, string> = {};

  // Map apiKey to primaryEnv
  if (entry.apiKey && skill.metadata?.primaryEnv) {
    overrides[skill.metadata.primaryEnv] = entry.apiKey;
  }

  // Add explicit env overrides
  if (entry.env) {
    for (const [key, value] of Object.entries(entry.env)) {
      overrides[key] = value;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
