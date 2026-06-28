import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

/**
 * Whether memory-v3 is the live injected memory source for this assistant,
 * suppressing v2 injection. Gated by workspace config (`memory.v3.live`): new
 * assistants are switched on at creation via a workspace migration, while
 * existing assistants stay on v2 until the value is set explicitly.
 */
export function isMemoryV3Live(config: AssistantConfig): boolean {
  return config.memory?.v3?.live === true;
}

/**
 * Whether the procedural-memory-as-skills behavior is enabled. Gated by the
 * `procedural-memory-as-skills` assistant feature flag (default off). When on,
 * the retrospective background task may author and update managed skills (with
 * procedure-scoped companion files), and the observe-first usage-prune stage may
 * retire assistant-authored skills that have gone stale.
 */
export function isProcToSkillsEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled("procedural-memory-as-skills", config);
}

/**
 * Whether procedural-memory-as-skills is ACTIVE: the flag is on AND memory-v3 is
 * the live injected source. The feature requires v3-live because the
 * usage-prune backstop — which retires stale assistant-authored skills — runs
 * only in the v3 maintain job. Enabling eager retrospective authoring without
 * that backstop would let assistant-authored skills accumulate unbounded, so
 * the feature is scoped to v3-live assistants. Gating the whole feature (the
 * retrospective skill-authoring step and its skill-authoring permission grant)
 * on this combined predicate keeps it coherently inert unless both are on.
 */
export function isProcToSkillsActive(config: AssistantConfig): boolean {
  return isProcToSkillsEnabled(config) && isMemoryV3Live(config);
}
