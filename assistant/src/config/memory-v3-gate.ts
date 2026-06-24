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
 * `procedural-memory-as-skills` assistant feature flag (default off). Routes
 * procedures to candidate notes and procedural knowledge to skill-linked facts,
 * and distills recurring procedures into managed skills.
 */
export function isProcToSkillsEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled("procedural-memory-as-skills", config);
}

/**
 * Whether procedural-memory-as-skills is ACTIVE: the flag is on AND memory-v3 is
 * the live injected source. The feature requires v3-live because the only place
 * the consolidation pass captures candidate notes is the
 * `{{PROC_TO_SKILLS_SECTION}}` of the v3 prompt template — the v2 template has no
 * such placeholder, so with the flag on but v3 not live the pass writes no
 * candidate notes. Gating the whole feature (prompt section, distill follow-up
 * enqueue, distill job, and the skill-authoring permission grant) on this
 * combined predicate keeps it coherently inert unless both are on.
 */
export function isProcToSkillsActive(config: AssistantConfig): boolean {
  return isProcToSkillsEnabled(config) && isMemoryV3Live(config);
}
