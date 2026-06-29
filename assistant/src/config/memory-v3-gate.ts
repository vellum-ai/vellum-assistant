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
 * assistants because skill retrieval rides the v3 lanes and the usage-prune
 * stage lives in the v3 maintain job. That prune ships observe-first: with
 * `memory.maintenance.skillPruneDays` at its default (`null`) it reports stale
 * assistant-authored skills (`prunableSkills`) but deletes none — so a v3-live
 * assistant authors skills without an automatic retirement bound until a
 * positive `skillPruneDays` is configured. Gating the whole feature (the
 * retrospective skill-authoring step and its permission grant) on this named
 * predicate keeps it coherently inert on non-v3 assistants.
 */
export function isProcToSkillsActive(config: AssistantConfig): boolean {
  return isMemoryV3Live(config);
}
