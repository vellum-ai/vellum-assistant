// ---------------------------------------------------------------------------
// Memory v2 — Skill catalog → embedded skill entries
// ---------------------------------------------------------------------------
//
// Mirrors v1's `seedSkillGraphNodes` (capability-seed.ts) for the v2 pipeline:
// enumerate the enabled-skill catalog, render each skill's prose statement via
// `buildSkillContent`, embed dense + sparse, upsert into the dedicated
// `memory_v2_skills` Qdrant collection, and prune stale points from prior
// catalog state.
//
// Unlike v1, skill entries are kept in a small in-process cache so the render
// path can fetch a `SkillEntry` synchronously by id without round-tripping to
// Qdrant. The cache is replaced atomically at the end of a successful seed
// run; on error the prior cache stays intact (skills are best-effort).

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { fromSkillSummary } from "../../skills/skill-memory.js";
import { getLogger } from "../../util/logger.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import {
  augmentMcpSetupDescription,
  buildSkillContent,
} from "./skill-content.js";
import { pruneSkillsExcept, upsertSkillEmbedding } from "./skill-qdrant.js";
import type { SkillEntry } from "./types.js";

const log = getLogger("memory-v2-skill-store");

/**
 * Module-level cache of rendered skill entries keyed by skill id. `null` until
 * the first successful seed run completes; replaced atomically on each
 * successful re-seed so callers always see a consistent snapshot.
 */
let entries: Map<string, SkillEntry> | null = null;

/**
 * Seed (or re-seed) the v2 skill embedding collection from the live skill
 * catalog. Idempotent: safe to call repeatedly. Best-effort: never throws —
 * any failure leaves the prior `entries` cache in place and logs a warning.
 *
 * Steps:
 *   1. Enumerate the local skill catalog and resolve each skill's enabled state
 *      (`resolveSkillStates`).
 *   2. Build a `SkillCapabilityInput` per enabled skill, applying the
 *      mcp-setup augmentation (mirrors v1) and the prose-style content render
 *      (`buildSkillContent`, capped at 500 chars).
 *   3. Defense-in-depth feature-flag filter: drop any skill whose declared
 *      `metadata.vellum.feature-flag` is currently disabled. `resolveSkillStates`
 *      already enforces this, but we mirror v1's enforcement point so the v2
 *      collection never holds an embedding for a flag-gated skill if the two
 *      ever drift.
 *   4. Embed all `content` strings in a single dense `embedWithBackend` call,
 *      and a per-skill synchronous `generateSparseEmbedding`.
 *   5. Upsert one Qdrant point per skill via `upsertSkillEmbedding` (keyed
 *      deterministically on id so re-runs replace in place).
 *   6. Call `pruneSkillsExcept` with the active id list to drop any stale
 *      points from prior catalog state (e.g. uninstalled skills).
 *   7. Replace the module-level `entries` cache with the freshly built map.
 */
export async function seedV2SkillEntries(): Promise<void> {
  try {
    const config = getConfig();
    const catalog = loadSkillCatalog();
    const resolved = resolveSkillStates(catalog, config);
    const enabled = resolved.filter((r) => r.state === "enabled");

    // Build the input list, applying the mcp-setup description augmentation
    // and the defense-in-depth feature-flag filter.
    const seeds: SkillEntry[] = [];
    for (const { summary } of enabled) {
      const flagKey = summary.featureFlag;
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) continue;

      const augmented = augmentMcpSetupDescription(fromSkillSummary(summary));
      const content = buildSkillContent(augmented);
      seeds.push({ id: summary.id, content });
    }

    // Embed all content strings in one batched call. Sparse vectors are
    // computed in-process (no network).
    const { vectors: denseVectors } = await embedWithBackend(
      config,
      seeds.map((s) => s.content),
    );

    const now = Date.now();
    const nextEntries = new Map<string, SkillEntry>();
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      await upsertSkillEmbedding({
        ...seed,
        dense: denseVectors[i],
        sparse: generateSparseEmbedding(seed.content),
        updatedAt: now,
      });
      nextEntries.set(seed.id, seed);
    }

    // Prune any points whose id is no longer in the active set.
    await pruneSkillsExcept(seeds.map((s) => s.id));

    // Atomically replace the cache only after every step above succeeds.
    entries = nextEntries;
  } catch (err) {
    log.warn({ err }, "Failed to seed v2 skill entries");
  }
}

/**
 * Synchronous lookup of a previously-seeded `SkillEntry` by skill id. Returns
 * `null` when the cache has not yet been populated, when the id is unknown,
 * or when a prior seed run dropped the id (e.g. the skill was disabled). Used
 * by the render path to attach skill-related content to outgoing prompts.
 */
export function getSkillCapability(id: string): SkillEntry | null {
  return entries?.get(id) ?? null;
}

/** @internal Test-only: clear the module-level cache. */
export function _resetSkillStoreForTests(): void {
  entries = null;
}
