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
