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
 * Whether procedural-memory-as-skills is ACTIVE: it is active whenever
 * memory-v3 is the live injected source. The feature is scoped to v3-live
 * assistants because the usage-prune backstop — which retires stale
 * assistant-authored skills — runs only in the v3 maintain job, and skill
 * retrieval rides the v3 lanes. Gating the whole feature (the retrospective
 * skill-authoring step and its skill-authoring permission grant) on this named
 * predicate keeps it coherently inert on non-v3 assistants.
 */
export function isProcToSkillsActive(config: AssistantConfig): boolean {
  return isMemoryV3Live(config);
}
