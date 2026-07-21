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

/**
 * Minimal structural view of the memory config the concept-page gate reads.
 * Accepting the shape (rather than the full `MemoryConfig`) lets call sites
 * pass either `config.memory` or the plugin-resolved memory slice, and keeps
 * partial configs in tests from throwing.
 */
export interface ConceptPageMemoryGateConfig {
  enabled?: boolean;
  v2?: { enabled?: boolean };
  v3?: { live?: boolean };
}

/**
 * Whether the concept-page memory substrate is active: the write pipeline
 * (`remember` → `memory/buffer.md` → consolidation → concept pages under
 * `memory/concepts/`), the concept-page Qdrant collection and its boot-time
 * maintenance (capability seeding, BM25 corpus stats, reembed reconcile), and
 * the static `<info>` memory block. The substrate is memory-v3's foundation —
 * v3's lanes, learned edges, and the memory graph all read these pages — and
 * the memory-v2 injection engine reads the same pages, so the substrate is
 * active whenever either consumer is on:
 *
 * - `memory.v3.live` — memory-v3 is the live injected source, or
 * - `memory.v2.enabled` — the v2 injection engine is enabled.
 *
 * An explicit `memory.enabled === false` wins over both. Equivalent to
 * `memoryTier(config)` being `"v2"` or `"v3"` (see `memory-tier.ts`). Once
 * every assistant is v3-live and the v1/v2 paths are removed, the v2 clause
 * disappears and this collapses to the `memory.enabled` check.
 */
export function usesConceptPageMemory(
  memory: ConceptPageMemoryGateConfig | undefined,
): boolean {
  if (memory?.enabled === false) {
    return false;
  }
  return memory?.v3?.live === true || memory?.v2?.enabled === true;
}
