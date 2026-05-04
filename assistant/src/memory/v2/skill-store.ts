// ---------------------------------------------------------------------------
// Memory v2 — Skill catalog → embedded skill entries
// ---------------------------------------------------------------------------
//
// Mirrors v1's `seedSkillGraphNodes` + `seedUninstalledCatalogSkillMemories`
// (capability-seed.ts) for the v2 pipeline: enumerate the enabled-skill
// catalog AND uninstalled catalog skills, render each skill's prose statement
// via `buildSkillContent`, embed dense + sparse, upsert into the dedicated
// `memory_v2_skills` Qdrant collection, and prune stale points from prior
// catalog state. Including uninstalled catalog skills ensures their activation
// hints are discoverable by intent so the model can auto-install them.
//
// Unlike v1, skill entries are kept in a small in-process cache so the render
// path can fetch a `SkillEntry` synchronously by id without round-tripping to
// Qdrant. The cache is replaced atomically at the end of a successful seed
// run; on error the prior cache stays intact (skills are best-effort).

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
import { loadSkillCatalog } from "../../config/skills.js";
import { getCatalog } from "../../skills/catalog-cache.js";
import {
  fromCatalogSkill,
  fromSkillSummary,
} from "../../skills/skill-memory.js";
import { getLogger } from "../../util/logger.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
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
 *   3b. Fetch the full remote catalog and seed any uninstalled skills so their
 *      activation hints are discoverable by semantic search. Best-effort: if
 *      the catalog fetch fails, only installed skills are seeded.
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

    // Track every locally-installed skill id (regardless of enabled/disabled
    // state) so the catalog-seeding loop below treats them all as "installed"
    // and never re-seeds a disabled skill from `getCatalog()` as if it were
    // uninstalled. Mirrors v1's `seedUninstalledCatalogSkillMemories`, which
    // keys off `loadSkillCatalog()` (the installed set) for the same reason.
    const installedIds = new Set<string>(catalog.map((s) => s.id));

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

    // Seed uninstalled catalog skills so their activation hints are
    // discoverable by intent (mirrors v1's seedUninstalledCatalogSkillMemories).
    // Track whether the catalog was available so we can guard pruning below.
    let catalogAvailable = false;
    try {
      const fullCatalog = await getCatalog();
      catalogAvailable = fullCatalog.length > 0;
      for (const entry of fullCatalog) {
        if (installedIds.has(entry.id)) continue;
        const flagKey = entry.metadata?.vellum?.["feature-flag"];
        if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config))
          continue;
        const content = buildSkillContent(fromCatalogSkill(entry));
        seeds.push({ id: entry.id, content });
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to fetch catalog for uninstalled skill seeding — continuing with installed skills only",
      );
    }

    // Embed all content strings in one batched call. Sparse vectors are
    // computed in-process (no network).
    const embedded = await embedWithBackend(
      config,
      seeds.map((s) => s.content),
    );
    const denseVectors = await Promise.all(
      embedded.vectors.map((v) =>
        applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
      ),
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

    // Prune stale points. When the catalog is unavailable (empty array from
    // network failure or cold cache), we cannot enumerate which uninstalled
    // catalog skills should exist, so skip pruning entirely to avoid
    // aggressively removing previously-seeded catalog skill embeddings.
    // Mirrors v1's safeguard in capability-seed.ts (lines 124–143).
    if (catalogAvailable) {
      await pruneSkillsExcept(seeds.map((s) => s.id));
    } else {
      log.info(
        "Catalog unavailable — skipping skill pruning to preserve prior catalog embeddings",
      );
    }

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

/**
 * Every skill id in the cache — both installed-and-enabled skills and
 * uninstalled-catalog skills. Empty before the first `seedV2SkillEntries`
 * run completes.
 */
export function getAllSkillIds(): string[] {
  return entries ? [...entries.keys()] : [];
}

/** @internal Test-only: clear the module-level cache. */
export function _resetSkillStoreForTests(): void {
  entries = null;
}
