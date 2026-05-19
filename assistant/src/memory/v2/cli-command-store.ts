// ---------------------------------------------------------------------------
// Memory v2 — `assistant` CLI subcommands → embedded capability entries
// ---------------------------------------------------------------------------
//
// Enumerate the top-level `assistant` CLI subcommands, render each as a prose
// capability statement that wraps the full `helpInformation()` output, embed
// dense + sparse, and upsert into `memory_v2_concept_pages` under the slug
// `cli-commands/<name>`. The router scores these alongside concept pages and
// skill entries; the injection layer surfaces hits under `### CLI Commands
// You Can Use` so the model can semantically discover a CLI capability it
// would not otherwise know to reach for.
//
// Mirrors `skill-store.ts` deliberately: same single-flight + generation
// coalescing, same dense + sparse + corpus-stats-aware sparse encoding, same
// payload-kind discriminator, same atomic cache replacement. Differences:
//   - No remote catalog — the source of truth is the local Commander tree.
//   - No per-entry feature-flag filter — flag gating already happens during
//     `buildCliProgramTree` (e.g. email/plugins commands are conditionally
//     registered).
//   - No MCP-style augmentation — Commander's description is the canonical
//     summary.

import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { applyCorrectionIfCalibrated } from "../anisotropy.js";
import {
  embedWithBackend,
  generateSparseEmbedding,
} from "../embedding-backend.js";
import { buildCliCommandContent } from "./cli-command-content.js";
import { invalidatePageIndex } from "./page-index.js";
import {
  backfillKindOnPointsWithPrefix,
  pruneSlugsWithPrefixExcept,
  upsertConceptPageEmbedding,
} from "./qdrant.js";
import {
  generateBm25DocEmbedding,
  getConceptPageCorpusStats,
} from "./sparse-bm25.js";
import type { CliCommandEntry } from "./types.js";

const log = getLogger("memory-v2-cli-command-store");

/**
 * Slug prefix under which CLI-command embeddings are indexed in
 * `memory_v2_concept_pages`. Concept-page slugs must match
 * `[a-z0-9][a-z0-9-]*(/...)*`, and `cli-commands` matches that pattern, so the
 * prefix coexists with hand-authored concept pages without escape work.
 */
export const CLI_COMMAND_SLUG_PREFIX = "cli-commands/";

/**
 * Payload discriminator written on every CLI-command-seeded Qdrant point.
 * Keeps CLI rows distinguishable from user-authored concept pages and from
 * skill rows that happen to live in adjacent namespaces, so prefix pruning
 * never deletes a hand-authored page sitting under `cli-commands/...`.
 */
const CLI_COMMAND_PAYLOAD_KIND = "cli-command";

/** Compose the unified-collection slug for a CLI command name. */
export function cliCommandSlugFor(name: string): string {
  return `${CLI_COMMAND_SLUG_PREFIX}${name}`;
}

/**
 * Module-level cache of rendered CLI-command entries keyed by command name.
 * `null` until the first successful seed run completes; replaced atomically
 * on each successful re-seed so callers always see a consistent snapshot.
 */
let entries: Map<string, CliCommandEntry> | null = null;
let requestedSeedGeneration = 0;
let processedSeedGeneration = 0;
let activeSeedDrain: Promise<void> | null = null;
let lastSeedError: unknown = null;
const seedWaiters: Array<{ generation: number; resolve: () => void }> = [];

/**
 * In-process latch for the legacy `kind` backfill. New upserts always write
 * `kind`, so once the latch is set there is no follow-up work to do this
 * process.
 */
let legacyKindBackfillDone = false;

/**
 * Seed (or re-seed) CLI-command embeddings into the unified concept-page
 * collection. Idempotent. Best-effort for background callers (errors are
 * logged but swallowed); pass `{ throwOnError: true }` from synchronous CLI
 * paths that want failures surfaced.
 *
 * Single-flight + coalesced: at most one seed runs at a time. Requests made
 * while a seed is in flight advance the requested generation; stale in-flight
 * snapshots are skipped before they write embeddings or replace the cache.
 */
export async function seedV2CliCommandEntries(
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
  if (activeSeedDrain) return;
  if (processedSeedGeneration >= requestedSeedGeneration) return;

  activeSeedDrain = drainSeedQueue().finally(() => {
    activeSeedDrain = null;
    startSeedDrainIfNeeded();
  });
}

async function drainSeedQueue(): Promise<void> {
  while (processedSeedGeneration < requestedSeedGeneration) {
    const generationToProcess = requestedSeedGeneration;
    await runSeedV2CliCommandEntries(generationToProcess);
    processedSeedGeneration = generationToProcess;
    resolveSeedWaiters();
  }
}

function resolveSeedWaiters(): void {
  for (let i = seedWaiters.length - 1; i >= 0; i -= 1) {
    const waiter = seedWaiters[i]!;
    if (waiter.generation > processedSeedGeneration) continue;
    seedWaiters.splice(i, 1);
    waiter.resolve();
  }
}

async function runSeedV2CliCommandEntries(generation: number): Promise<void> {
  try {
    const config = getConfig();
    // Dynamic import so callers that only need `getCliCommandCapability` or
    // `listCliCommandEntries` (e.g. the render path inside `injection.ts` and
    // the `page-index.ts` dependency loader) never drag the full CLI command
    // graph into their import tree. The CLI tree pulls in many provider and
    // workspace modules whose presence has been a recurring source of test-
    // mock cascades and circular-import surprises.
    const { buildCliProgramTree } = await import("../../cli/program.js");
    const program = buildCliProgramTree();

    const seeds: CliCommandEntry[] = [];
    for (const cmd of program.commands) {
      const name = cmd.name();
      // Skip the `help` builtin Commander adds automatically — it carries no
      // capability information of its own and is uniform across commands.
      if (name === "help") continue;
      const description = cmd.description();
      const content = buildCliCommandContent(
        name,
        description,
        cmd.helpInformation(),
      );
      seeds.push({ id: name, description, content });
    }

    const nextEntries = new Map<string, CliCommandEntry>();
    let denseVectors: number[][] = [];
    let encodeSparse: (
      input: string,
    ) => ReturnType<typeof generateSparseEmbedding> = generateSparseEmbedding;
    if (seeds.length > 0) {
      const embedded = await embedWithBackend(
        config,
        seeds.map((s) => s.content),
      );
      denseVectors = await Promise.all(
        embedded.vectors.map((v) =>
          applyCorrectionIfCalibrated(v, embedded.provider, embedded.model),
        ),
      );

      // CLI commands share the concept-page Qdrant collection, so the sparse
      // vector must use the same stemmed BM25 encoding as the concept-page
      // documents. Fall back to the legacy TF encoder only during the cold-
      // start window before corpus stats finish building — same rationale as
      // the skill-store path.
      const corpusStats = getConceptPageCorpusStats();
      encodeSparse = (input: string) =>
        corpusStats
          ? generateBm25DocEmbedding(input, corpusStats, {
              k1: config.memory.v2.bm25_k1,
              b: config.memory.v2.bm25_b,
            })
          : generateSparseEmbedding(input);
    }

    if (generation !== requestedSeedGeneration) {
      log.info(
        { generation, latestGeneration: requestedSeedGeneration },
        "Skipping stale v2 CLI-command seed result",
      );
      lastSeedError = null;
      return;
    }

    if (seeds.length > 0) {
      const now = Date.now();
      await Promise.all(
        seeds.map((seed, i) =>
          upsertConceptPageEmbedding({
            slug: cliCommandSlugFor(seed.id),
            dense: denseVectors[i],
            sparse: encodeSparse(seed.content),
            updatedAt: now,
            kind: CLI_COMMAND_PAYLOAD_KIND,
          }),
        ),
      );
      for (const seed of seeds) {
        nextEntries.set(seed.id, seed);
      }
    }

    // The CLI tree is always available (no remote catalog), so pruning is
    // unconditional. Run the legacy `kind` backfill once per process so
    // pre-discriminator rows become prunable.
    const knownIds = new Set(seeds.map((s) => s.id));
    if (!legacyKindBackfillDone) {
      try {
        await backfillKindOnPointsWithPrefix(
          CLI_COMMAND_SLUG_PREFIX,
          CLI_COMMAND_PAYLOAD_KIND,
          knownIds,
        );
        legacyKindBackfillDone = true;
      } catch (err) {
        log.warn(
          { err },
          "Failed to backfill kind on legacy CLI-command points — pruning may leave orphans this run",
        );
      }
    }
    await pruneSlugsWithPrefixExcept(
      CLI_COMMAND_SLUG_PREFIX,
      seeds.map((s) => s.id),
      { kind: CLI_COMMAND_PAYLOAD_KIND },
    );

    // Atomically replace the cache only after every step above succeeds.
    entries = nextEntries;
    invalidatePageIndex();
    lastSeedError = null;
  } catch (err) {
    lastSeedError = err;
    log.warn({ err }, "Failed to seed v2 CLI-command entries");
  }
}

/**
 * Synchronous lookup of a previously-seeded `CliCommandEntry` by command
 * name. Returns `null` when the cache has not yet been populated, when the
 * id is unknown, or when a prior seed run dropped the id.
 *
 * Accepts either a bare command name (`attachment`) or its unified-collection
 * slug (`cli-commands/attachment`) so render-side callers can pass through
 * what they have without a manual prefix strip.
 *
 * Returns a frozen copy so callers cannot mutate the underlying cache entry.
 */
export function getCliCommandCapability(
  idOrSlug: string,
): CliCommandEntry | null {
  const id = idOrSlug.startsWith(CLI_COMMAND_SLUG_PREFIX)
    ? idOrSlug.slice(CLI_COMMAND_SLUG_PREFIX.length)
    : idOrSlug;
  const entry = entries?.get(id);
  return entry ? Object.freeze({ ...entry }) : null;
}

/** True iff the slug refers to a CLI-command entry in the unified collection. */
export function isCliCommandSlug(slug: string): boolean {
  return slug.startsWith(CLI_COMMAND_SLUG_PREFIX);
}

/**
 * Snapshot of the in-process CLI-command cache, sorted by command name (ASCII
 * order) for determinism. Returns a freshly allocated array of frozen entry
 * copies on each call.
 */
export function listCliCommandEntries(): CliCommandEntry[] {
  if (!entries) return [];
  return [...entries.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => Object.freeze({ ...entry }));
}

/** @internal Test-only: clear the module-level cache. */
export function _resetCliCommandStoreForTests(): void {
  entries = null;
  requestedSeedGeneration = 0;
  processedSeedGeneration = 0;
  activeSeedDrain = null;
  seedWaiters.splice(0, seedWaiters.length);
  lastSeedError = null;
  legacyKindBackfillDone = false;
}
