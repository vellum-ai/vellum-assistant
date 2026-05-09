// ---------------------------------------------------------------------------
// Memory v2 — Skill catalog → embedded skill entries
// ---------------------------------------------------------------------------
//
// Enumerate the enabled-skill catalog AND uninstalled catalog skills, render
// each skill's prose statement via `buildSkillContent`, embed dense + sparse,
// and upsert into `memory_v2_concept_pages` under the slug `skills/<id>`.
// Including uninstalled catalog skills ensures their activation hints are
// discoverable by intent so the model can auto-install them.
//
// Skills share the concept-page collection rather than living in a dedicated
// one so the per-turn activation pipeline scores them against the same
// candidate ANN as concept pages, with the same decay and spread machinery.
// The render path branches on the `skills/` slug prefix to surface them as
// the `### Skills You Can Use` subsection.
//
// Skill entries are kept in a small in-process cache so the render path can
// fetch a `SkillEntry` synchronously by id without round-tripping to Qdrant.
// The cache is replaced atomically at the end of a successful seed run; on
// error the prior cache stays intact (skills are best-effort).

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
  pruneSlugsWithPrefixExcept,
  upsertConceptPageEmbedding,
} from "./qdrant.js";
import {
  augmentMcpSetupDescription,
  buildSkillContent,
} from "./skill-content.js";
import {
  generateBm25DocEmbedding,
  getConceptPageCorpusStats,
} from "./sparse-bm25.js";
import type { SkillEntry } from "./types.js";

const log = getLogger("memory-v2-skill-store");

/**
 * Slug prefix under which skill embeddings are indexed in
 * `memory_v2_concept_pages`. Concept-page slugs must match
 * `[a-z0-9][a-z0-9-]*(/...)*`, and `skills` matches that pattern, so the
 * prefix coexists with hand-authored concept pages without escape work.
 */
export const SKILL_SLUG_PREFIX = "skills/";

/**
 * Payload discriminator written on every skill-seeded Qdrant point. Keeps
 * skill rows distinguishable from user-authored concept pages that happen to
 * be slugged under `skills/...`, so prefix pruning never deletes a hand-
 * authored page sitting in the same namespace.
 */
const SKILL_PAYLOAD_KIND = "skill";

/** Compose the unified-collection slug for a skill id. */
export function skillSlugFor(id: string): string {
  return `${SKILL_SLUG_PREFIX}${id}`;
}

/**
 * Module-level cache of rendered skill entries keyed by skill id. `null` until
 * the first successful seed run completes; replaced atomically on each
 * successful re-seed so callers always see a consistent snapshot.
 */
let entries: Map<string, SkillEntry> | null = null;

/**
 * Seed (or re-seed) skill embeddings into the unified concept-page collection.
 * Idempotent. Defaults to best-effort (errors are logged but swallowed) for
 * background callers like daemon startup; pass `{ throwOnError: true }` from
 * synchronous CLI-driven paths that need to surface failures to the operator.
 *
 * Single-flight + coalesced: at most one seed runs at a time, and concurrent
 * callers are coalesced into one follow-up re-snapshot that runs after the
 * in-flight seed completes. Without this, an older snapshot can finish after
 * a newer one and overwrite the newer skill state. Strict callers observe
 * the most recent run's outcome via `lastSeedError`.
 */
let seedTail: Promise<void> = Promise.resolve();
let seedPending: Promise<void> | null = null;
let lastSeedError: unknown = null;

export async function seedV2SkillEntries(
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  if (!seedPending) {
    const next = seedTail.then(async () => {
      seedPending = null;
      await runSeedOnce();
    });
    seedTail = next.catch(() => {});
    seedPending = next;
  }
  await seedPending;
  if (opts.throwOnError && lastSeedError) {
    throw lastSeedError;
  }
}

/**
 * Steps (per run):
 *   1. Enumerate the local skill catalog and resolve each skill's enabled
 *      state (`resolveSkillStates`).
 *   2. Build a `SkillEntry` per enabled skill, applying the mcp-setup
 *      augmentation and the prose-style content render (`buildSkillContent`,
 *      capped at 500 chars).
 *   3. Defense-in-depth feature-flag filter: drop any skill whose declared
 *      `metadata.vellum.feature-flag` is currently disabled.
 *   3b. Fetch the full remote catalog and seed any uninstalled skills so
 *      their activation hints are discoverable by semantic search. Best-effort:
 *      if the catalog fetch fails, only installed skills are seeded.
 *   4. Embed all `content` strings in a single dense `embedWithBackend` call,
 *      and a per-skill synchronous `generateSparseEmbedding`.
 *   5. Upsert one Qdrant point per skill via `upsertConceptPageEmbedding`
 *      keyed deterministically on slug `skills/<id>`.
 *   6. Call `pruneSlugsWithPrefixExcept(SKILL_SLUG_PREFIX, ...)` to drop any
 *      stale points from prior catalog state (e.g. uninstalled skills).
 *   7. Replace the module-level `entries` cache with the freshly built map.
 */
async function runSeedOnce(): Promise<void> {
  try {
    const config = getConfig();
    const catalog = loadSkillCatalog();
    const resolved = resolveSkillStates(catalog, config);
    const enabled = resolved.filter((r) => r.state === "enabled");

    // Track every locally-installed skill id (regardless of enabled/disabled
    // state) so the catalog-seeding loop below treats them all as "installed"
    // and never re-seeds a disabled skill from `getCatalog()` as if it were
    // uninstalled.
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
    // discoverable by intent. Track whether the catalog was available so we
    // can guard pruning below.
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

    // Embed all content strings in one batched call when there is anything to
    // embed. Skipping the call when `seeds` is empty avoids throwing on an
    // unavailable embedding backend in the all-disabled case, so pruning and
    // cache replacement still run and clear stale state.
    const nextEntries = new Map<string, SkillEntry>();
    if (seeds.length > 0) {
      const embedded = await embedWithBackend(
        config,
        seeds.map((s) => s.content),
      );
      const denseVectors = await Promise.all(
        embedded.vectors.map((v) =>
          applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
        ),
      );

      // Skills share the concept-page Qdrant collection, so the sparse vector
      // must use the same stemmed BM25 encoding the concept-page documents
      // carry — otherwise the stemmed BM25 query vectors used by callers (see
      // `simBatch`, `activation.selectCandidates`, recall) hash to different
      // buckets than the stored skill vectors and skip the sparse channel
      // entirely. Fall back to the legacy TF encoder only during the cold-start
      // window before corpus stats finish building.
      const corpusStats = getConceptPageCorpusStats();
      const encodeSparse = (input: string) =>
        corpusStats
          ? generateBm25DocEmbedding(input, corpusStats, {
              k1: config.memory.v2.bm25_k1,
              b: config.memory.v2.bm25_b,
            })
          : generateSparseEmbedding(input);

      const now = Date.now();
      await Promise.all(
        seeds.map((seed, i) =>
          upsertConceptPageEmbedding({
            slug: skillSlugFor(seed.id),
            dense: denseVectors[i],
            sparse: encodeSparse(seed.content),
            updatedAt: now,
            kind: SKILL_PAYLOAD_KIND,
          }),
        ),
      );
      for (const seed of seeds) {
        nextEntries.set(seed.id, seed);
      }
    }

    // Prune stale skill slugs. When the catalog is unavailable (empty array
    // from network failure or cold cache), we cannot enumerate which
    // uninstalled catalog skills should exist, so skip pruning entirely to
    // avoid aggressively removing previously-seeded catalog skill embeddings.
    if (catalogAvailable) {
      await pruneSlugsWithPrefixExcept(
        SKILL_SLUG_PREFIX,
        seeds.map((s) => s.id),
        { kind: SKILL_PAYLOAD_KIND },
      );
    } else {
      log.info(
        "Catalog unavailable — skipping skill pruning to preserve prior catalog embeddings",
      );
    }

    // Atomically replace the cache only after every step above succeeds.
    entries = nextEntries;
    lastSeedError = null;
  } catch (err) {
    lastSeedError = err;
    log.warn({ err }, "Failed to seed v2 skill entries");
  }
}

/**
 * Synchronous lookup of a previously-seeded `SkillEntry` by skill id. Returns
 * `null` when the cache has not yet been populated, when the id is unknown,
 * or when a prior seed run dropped the id (e.g. the skill was disabled).
 *
 * Accepts either a bare skill id (`example-skill`) or its unified-collection
 * slug (`skills/example-skill`) so render-side callers can pass through what
 * they have without a manual prefix strip.
 */
export function getSkillCapability(idOrSlug: string): SkillEntry | null {
  const id = idOrSlug.startsWith(SKILL_SLUG_PREFIX)
    ? idOrSlug.slice(SKILL_SLUG_PREFIX.length)
    : idOrSlug;
  return entries?.get(id) ?? null;
}

/** True iff the slug refers to a skill entry in the unified collection. */
export function isSkillSlug(slug: string): boolean {
  return slug.startsWith(SKILL_SLUG_PREFIX);
}

/** @internal Test-only: clear the module-level cache. */
export function _resetSkillStoreForTests(): void {
  entries = null;
  seedTail = Promise.resolve();
  seedPending = null;
  lastSeedError = null;
}
