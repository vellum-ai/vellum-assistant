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
// The cache is replaced atomically from the local catalog at the end of a seed
// run — including when the dense embedding backend is unavailable, in which
// case only the dense Qdrant write is deferred so the cache (and the v3 needle
// lane it feeds) still reflects the current skills. An unexpected error in
// another step leaves the prior cache intact (skills are best-effort).

import { listCatalogSkills, listInstalledSkills } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { generateSparseEmbedding } from "../../../../persistence/embeddings/embedding-backend.js";
import { getLogger } from "../../../../util/logger.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import { embedWithBackend } from "../embeddings.js";
import { invalidatePageIndex } from "./page-index.js";
import {
  backfillKindOnPointsWithPrefix,
  pruneSlugsWithPrefixExcept,
  upsertConceptPageEmbedding,
} from "./qdrant.js";
import {
  ALWAYS_CANDIDATE_CARD_CHARS,
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
let requestedSeedGeneration = 0;
let processedSeedGeneration = 0;
let activeSeedDrain: Promise<void> | null = null;
let lastSeedError: unknown = null;
const seedWaiters: Array<{ generation: number; resolve: () => void }> = [];

/**
 * Seed (or re-seed) skill embeddings into the unified concept-page collection.
 * Idempotent. Defaults to best-effort (errors are logged but swallowed) for
 * background callers like daemon startup; pass `{ throwOnError: true }` from
 * synchronous CLI-driven paths that need to surface failures to the operator.
 *
 * Single-flight + coalesced: at most one seed runs at a time. Requests made
 * while a seed is in flight advance the requested generation; stale in-flight
 * snapshots are skipped before they write embeddings or replace the cache,
 * then the drain loop immediately processes the latest generation. Strict
 * callers observe the awaited generation's latest outcome via `lastSeedError`.
 */

/**
 * In-process latch for the legacy `kind` backfill (see
 * {@link backfillKindOnPointsWithPrefix}). New upserts always write `kind`,
 * so once the latch is set there is no follow-up work to do this process.
 */
let legacyKindBackfillDone = false;

/**
 * Steps (per run):
 *   1. Enumerate the installed skill catalog with resolved states
 *      (`listInstalledSkills`). Feature-flag gating is resolved host-side:
 *      gated skills arrive as `state: "unavailable"` and are not seeded.
 *   2. Build a `SkillEntry` per enabled skill, applying the mcp-setup
 *      augmentation and the prose-style content render (`buildSkillContent`,
 *      capped at 500 chars).
 *   3b. Fetch the full remote catalog (`listCatalogSkills`) and seed any
 *      uninstalled skills so their activation hints are discoverable by
 *      semantic search. Best-effort: if the catalog fetch fails, only
 *      installed skills are seeded.
 *   4. Embed all `content` strings in a single dense `embedWithBackend` call,
 *      and a per-skill synchronous `generateSparseEmbedding`.
 *   5. Upsert one Qdrant point per skill via `upsertConceptPageEmbedding`
 *      keyed deterministically on slug `skills/<id>`.
 *   6. Call `pruneSlugsWithPrefixExcept(SKILL_SLUG_PREFIX, ...)` to drop any
 *      stale points from prior catalog state (e.g. uninstalled skills).
 *   7. Replace the module-level `entries` cache with the freshly built map.
 */
export async function seedV2SkillEntries(
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  const generation = ++requestedSeedGeneration;
  const waiter = new Promise<void>((resolve) => {
    seedWaiters.push({ generation, resolve });
  });
  startSeedDrainIfNeeded();
  await waiter;
  if (opts.throwOnError && lastSeedError) {
    throw lastSeedError;
  }
}

function startSeedDrainIfNeeded(): void {
  if (activeSeedDrain) {
    return;
  }
  if (processedSeedGeneration >= requestedSeedGeneration) {
    return;
  }

  activeSeedDrain = drainSeedQueue().finally(() => {
    activeSeedDrain = null;
    startSeedDrainIfNeeded();
  });
}

async function drainSeedQueue(): Promise<void> {
  while (processedSeedGeneration < requestedSeedGeneration) {
    const generationToProcess = requestedSeedGeneration;
    await runSeedV2SkillEntries(generationToProcess);
    processedSeedGeneration = generationToProcess;
    resolveSeedWaiters();
  }
}

function resolveSeedWaiters(): void {
  for (let i = seedWaiters.length - 1; i >= 0; i -= 1) {
    const waiter = seedWaiters[i]!;
    if (waiter.generation > processedSeedGeneration) {
      continue;
    }
    seedWaiters.splice(i, 1);
    waiter.resolve();
  }
}

async function runSeedV2SkillEntries(generation: number): Promise<void> {
  try {
    const config = getConfig();
    const installed = await listInstalledSkills();
    const enabled = installed.filter((s) => s.state === "enabled");

    // Track every locally-installed skill id (regardless of enabled/disabled/
    // unavailable state) so the catalog-seeding loop below treats them all as
    // "installed" and never re-seeds a disabled skill from the remote catalog
    // as if it were uninstalled.
    const installedIds = new Set<string>(installed.map((s) => s.id));

    // Build the input list, applying the mcp-setup description augmentation.
    // Flag-gated skills arrive as `state: "unavailable"` and are excluded by
    // the enabled filter.
    const seeds: SkillEntry[] = [];
    for (const skill of enabled) {
      const augmented = augmentMcpSetupDescription(skill);
      // Always-candidate skills are pinned into the selector pool every turn, so
      // they get a larger budget for a fuller, multi-mode capability statement.
      const content = buildSkillContent(
        augmented,
        skill.alwaysCandidate ? ALWAYS_CANDIDATE_CARD_CHARS : undefined,
      );
      seeds.push({ id: skill.id, content });
    }

    // Seed uninstalled catalog skills so their activation hints are
    // discoverable by intent. Track whether the catalog was available so we
    // can guard pruning below.
    //
    // Build the legacy-backfill allowlist in parallel: every locally
    // installed skill id (regardless of enabled state) plus every remote
    // catalog id. Restricting the backfill to this set keeps user-authored
    // concept pages that happen to live under `skills/<slug>` from being
    // mis-tagged and then pruned. See `backfillKindOnPointsWithPrefix`.
    const knownSkillIds = new Set<string>(installedIds);
    let catalogAvailable = false;
    try {
      const fullCatalog = await listCatalogSkills();
      catalogAvailable = fullCatalog.length > 0;
      for (const entry of fullCatalog) {
        knownSkillIds.add(entry.id);
        if (installedIds.has(entry.id)) {
          continue;
        }
        if (entry.state === "unavailable") {
          continue;
        }
        const content = buildSkillContent(entry);
        seeds.push({ id: entry.id, content });
      }
    } catch (err) {
      log.warn(
        { err },
        "Failed to fetch catalog for uninstalled skill seeding — continuing with installed skills only",
      );
    }

    // Build the dense + sparse vectors for the Qdrant write. Sparse (BM25/TF)
    // encoding is computed locally and needs no backend; only the dense vectors
    // require `embedWithBackend`, which is unconfigured during the cold-start
    // window before a managed-proxy embedding credential is provisioned.
    //
    // A dense-embed failure is non-fatal to the in-memory cache: the v3 needle
    // finder lane and always-candidate skill pinning read skills from `entries`
    // / the page index, NOT from Qdrant, so the cache is populated from the
    // local catalog regardless of backend state and skills stay discoverable
    // from first boot. Only the dense Qdrant upsert is skipped; the managed-
    // credential reseed (`maybeReseedCapabilitiesAfterManagedCredential`) and
    // the v3 maintain pass backfill the dense vectors once the backend recovers.
    const nextEntries = new Map<string, SkillEntry>();
    let denseVectors: number[][] = [];
    let denseAvailable = false;
    let denseError: unknown = null;
    let encodeSparse: (
      input: string,
    ) => ReturnType<typeof generateSparseEmbedding> = generateSparseEmbedding;
    if (seeds.length > 0) {
      // Skills share the concept-page Qdrant collection, so the sparse vector
      // must use the same stemmed BM25 encoding the concept-page documents
      // carry — otherwise the stemmed BM25 query vectors used by callers (see
      // `simBatch`, `activation.selectCandidates`, recall) hash to different
      // buckets than the stored skill vectors and skip the sparse channel
      // entirely. Fall back to the legacy TF encoder only during the cold-start
      // window before corpus stats finish building.
      const corpusStats = getConceptPageCorpusStats();
      encodeSparse = (input: string) =>
        corpusStats
          ? generateBm25DocEmbedding(input, corpusStats, {
              k1: config.memory.v2.bm25_k1,
              b: config.memory.v2.bm25_b,
            })
          : generateSparseEmbedding(input);
      try {
        const embedded = await embedWithBackend(
          config,
          seeds.map((s) => s.content),
        );
        denseVectors = await Promise.all(
          embedded.vectors.map((v) =>
            applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
          ),
        );
        denseAvailable = true;
      } catch (err) {
        denseError = err;
        log.warn(
          { err },
          "Embedding backend unavailable — seeding skill cache without dense Qdrant vectors; the needle lane surfaces skills from the cache and the dense lane backfills when the backend recovers",
        );
      }
    }

    if (generation !== requestedSeedGeneration) {
      log.info(
        { generation, latestGeneration: requestedSeedGeneration },
        "Skipping stale v2 skill seed result",
      );
      lastSeedError = null;
      return;
    }

    // Populate the in-memory cache (and therefore the page index / needle lane)
    // from the local catalog regardless of dense availability.
    for (const seed of seeds) {
      nextEntries.set(seed.id, seed);
    }

    // Write Qdrant points only when dense vectors were produced. In the
    // degraded (backend-unavailable) path we skip Qdrant mutation entirely —
    // both the upsert and the prune below — so we never write half-formed
    // points or reconcile the collection against a set we did not persist.
    if (seeds.length > 0 && denseAvailable) {
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
    }

    // Prune stale skill slugs. Skip when the catalog is unavailable (empty array
    // from network failure or cold cache — we cannot enumerate which uninstalled
    // catalog skills should exist) OR when dense vectors were not written this
    // run (don't reconcile Qdrant against points we did not refresh). The
    // `seeds.length === 0` branch still prunes under an available catalog so the
    // all-disabled case clears stale rows.
    if (catalogAvailable && (denseAvailable || seeds.length === 0)) {
      // Tag legacy skill points missing `payload.kind` before pruning so the
      // kind-scoped prune can see them. Once-per-process; the backfill is
      // idempotent (server-side `is_empty` filter), so a partial failure
      // converges on retry.
      if (!legacyKindBackfillDone) {
        try {
          await backfillKindOnPointsWithPrefix(
            SKILL_SLUG_PREFIX,
            SKILL_PAYLOAD_KIND,
            knownSkillIds,
          );
          legacyKindBackfillDone = true;
        } catch (err) {
          log.warn(
            { err },
            "Failed to backfill kind on legacy skill points — pruning may leave orphans this run",
          );
        }
      }
      await pruneSlugsWithPrefixExcept(
        SKILL_SLUG_PREFIX,
        seeds.map((s) => s.id),
        { kind: SKILL_PAYLOAD_KIND },
      );
    } else if (!catalogAvailable) {
      log.info(
        "Catalog unavailable — skipping skill pruning to preserve prior catalog embeddings",
      );
    }

    // Atomically replace the cache from the freshly enumerated skills. The local
    // resolution (`listInstalledSkills`) is authoritative, so a skill the config
    // just disabled or removed drops out here even when the remote catalog is
    // unavailable. Drop the page-index cache so the next router invocation
    // observes the new skill set (skill entries share the unified concept-page
    // collection and surface in the same index).
    entries = nextEntries;
    invalidatePageIndex();

    // Surface a dense-embed failure to `throwOnError` callers (the managed-
    // credential reseed and the operator reembed route) so the existing retry +
    // maintain machinery backfills the dense lane. The in-memory cache is
    // already updated above, so the needle lane is fixed regardless.
    lastSeedError = denseError;
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
 *
 * Returns a frozen copy so callers cannot mutate the underlying cache entry
 * — matches the defensive-copy contract of `listSkillEntries`.
 */
export function getSkillCapability(idOrSlug: string): SkillEntry | null {
  const id = idOrSlug.startsWith(SKILL_SLUG_PREFIX)
    ? idOrSlug.slice(SKILL_SLUG_PREFIX.length)
    : idOrSlug;
  const entry = entries?.get(id);
  return entry ? Object.freeze({ ...entry }) : null;
}

/** True iff the slug refers to a skill entry in the unified collection. */
export function isSkillSlug(slug: string): boolean {
  return slug.startsWith(SKILL_SLUG_PREFIX);
}

/**
 * Snapshot of the in-process skill cache, sorted by skill id (ASCII order)
 * for determinism. Returns a freshly allocated array of frozen entry copies
 * on each call, so callers cannot mutate the underlying cache — neither by
 * reassigning the array nor by writing through entry fields.
 *
 * The cache is replaced atomically by `seedV2SkillEntries`, so a snapshot
 * may be stale once a subsequent seed run completes. Callers that need
 * up-to-the-moment state must re-call this after awaiting the seed.
 */
export function listSkillEntries(): SkillEntry[] {
  if (!entries) {
    return [];
  }
  return [...entries.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => Object.freeze({ ...entry }));
}

/** @internal Test-only: clear the module-level cache. */
export function _resetSkillStoreForTests(): void {
  entries = null;
  requestedSeedGeneration = 0;
  processedSeedGeneration = 0;
  activeSeedDrain = null;
  seedWaiters.splice(0, seedWaiters.length);
  lastSeedError = null;
  legacyKindBackfillDone = false;
}
