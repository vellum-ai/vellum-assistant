import type { AssistantConfig } from "./schema.js";

/**
 * Whether memory as a whole is on — the user-facing master switch. Memory is
 * on unless `memory.enabled` is explicitly set to `false`. Canonical home for
 * the check; the config-singleton `isMemoryEnabled()` in
 * `persistence/jobs-store.ts` delegates here. Accepts any object carrying the
 * `memory` slice, so callers holding only the plugin-resolved slice (e.g. the
 * memory plugin's `getMemoryConfig()`) can gate without the full config.
 */
export function isMemoryEnabled(
  config: Pick<AssistantConfig, "memory">,
): boolean {
  return config.memory?.enabled !== false;
}

/**
 * Whether the legacy graph/PKB memory engine (tier v1) is the live tier:
 * memory is on and no concept-page consumer (v3 live or the v2 injection
 * engine) is. Like {@link isMemoryEnabled}, accepts a `memory`-slice view.
 *
 * THE memory-off semantics for v1, stated once and shared by every v1 path
 * (job dispatch, the job handlers, maintenance scheduling, startup seeding,
 * the filing routes): `memory.enabled === false` means v1 is NOT the live
 * tier, so v1 work is skipped exactly as it is under the concept-page
 * substrate. Turning memory off is a user-facing opt-out — it must never be
 * the one state in which the daemon still LLM-extracts, embeds, or files into
 * the legacy graph. Ask this predicate, never `usesConceptPageMemory` alone:
 * the two agree on every tier EXCEPT memory-off, where the bare substrate
 * check reports "v1" and would keep v1 running.
 */
export function isMemoryV1Active(
  config: Pick<AssistantConfig, "memory">,
): boolean {
  return isMemoryEnabled(config) && !usesConceptPageMemory(config.memory);
}

/**
 * Whether the v2 activation/router engine performs turn-time selection:
 * memory is on, `memory.v2.enabled` is set, and v3 is NOT the live injected
 * source. Distinct from `usesConceptPageMemory`: `memory.v2.enabled` defaults
 * true and typically stays set on v3-live assistants, so this predicate is the
 * ONLY correct way to ask "should v2 select this turn" — a direct
 * `memory.v2.enabled` read misbehaves under v3.
 */
export function isV2InjectionEngineActive(config: AssistantConfig): boolean {
  return (
    isMemoryEnabled(config) &&
    config.memory?.v2?.enabled === true &&
    !isMemoryV3Live(config)
  );
}

/**
 * Whether `memory.v2.enabled` is explicitly `false` — deliberately NOT the
 * negation of `isV2InjectionEngineActive`, since the key defaults true. Names
 * the explicit-false semantics `daemon/embedding-reconcile.ts` relies on: an
 * explicit opt-out suppresses concept-page reconcile work even where the
 * default would allow it.
 */
export function isMemoryV2ExplicitlyDisabled(config: AssistantConfig): boolean {
  return config.memory?.v2?.enabled === false;
}

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
 * Whether memory-v3 is the live TIER: v3 is the live injected source AND
 * memory as a whole is on. Exactly `memoryTier(config) === "v3"` (see
 * `memory-tier.ts`), and the difference from {@link isMemoryV3Live} is the
 * memory-off case — `"off"` outranks `"v3"`, so a `memory.v3.live` assistant
 * whose owner switched Memory off is NOT on the v3 tier. Every v3-tier-scoped
 * FEATURE asks this predicate; only the injection-suppression checks that must
 * mirror the raw `memory.v3.live` key ask {@link isMemoryV3Live} directly.
 *
 * The two features gated on it, and why they must agree:
 *
 * - The memory concept graph — the single source of truth for both
 *   `GET /memory-graph` (`supported`) and the cheap `graph_supported` bit on
 *   `GET /memory/stats`, so the advertised capability and the actual build can
 *   never drift. The graph builds off the v3 concept-page substrate.
 * - Procedural-memory-as-skills — the retrospective's skill-authoring step and
 *   its permission grant. Scoped to the v3 tier because skill retrieval rides
 *   the v3 lanes and the usage-prune stage lives in the v3 maintain job. That
 *   prune ships observe-first: with `memory.maintenance.skillPruneDays` at its
 *   default (`null`) it reports stale assistant-authored skills
 *   (`prunableSkills`) but deletes none — so a v3-tier assistant authors skills
 *   without an automatic retirement bound until a positive `skillPruneDays` is
 *   configured.
 *
 * Both write into memory on the user's behalf, so both honor the Memory
 * opt-out identically: one predicate, one answer.
 */
export function isV3TierActive(config: AssistantConfig): boolean {
  return isMemoryEnabled(config) && isMemoryV3Live(config);
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
