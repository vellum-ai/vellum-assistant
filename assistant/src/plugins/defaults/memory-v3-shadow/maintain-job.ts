/**
 * Memory v3 — `memory_v3_maintain` job handler.
 *
 * A flag-gated, best-effort self-maintenance pass over the v3 section dense
 * store and the in-memory lanes. It runs two independent stages, in order:
 *
 *   1. **Section re-embed** — diff the page index by `modifiedAt` against the
 *      last successful pass (the high-water mark below), and for every page that
 *      is new or edited since then, re-chunk it into sections
 *      (`buildSectionIndex`) and refresh its dense points
 *      (`deleteSectionsForArticle` + `upsertSections`). This keeps the
 *      section-grain Qdrant collection in sync with on-disk page edits so the
 *      dense lane retrieves against current content. The high-water mark is
 *      advanced only after the pass completes (captured before any potential
 *      mtime bumps) so a page is not re-embedded forever.
 *   2. **Lane invalidation** — `invalidateLanes()` so the next turn rebuilds the
 *      in-memory section index, needle, and edge graph from the freshly-updated
 *      pages.
 *
 * Best-effort by construction: each stage is wrapped so a failure in one is
 * logged and recorded in the outcome but does NOT abort the others. A single
 * page whose embed fails does not abort the rest of the re-embed stage. The job
 * is a no-op (returns a disabled outcome) unless `memory-v3-shadow` OR
 * `memory-v3-live` is enabled — the same flags that gate the v3 plugin.
 *
 * Dependency-injectable: `deps` lets tests substitute the page-index reader,
 * section builder, dense-store ops, and `invalidateLanes` without process-global
 * module mocks.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../../config/types.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../memory/checkpoints.js";
import type { MemoryJob } from "../../../memory/jobs-store.js";
import { getPageIndex } from "../../../memory/v2/page-index.js";
import { readPage } from "../../../memory/v2/page-store.js";
import { getLogger } from "../../../util/logger.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { isCapabilitySlug, renderCapabilityContent } from "./capabilities.js";
import {
  deleteSectionsForArticle as realDeleteSectionsForArticle,
  ensureSectionCollection as realEnsureSectionCollection,
  upsertSections as realUpsertSections,
} from "./section-dense-store.js";
import { buildSectionIndex as realBuildSectionIndex } from "./sections.js";
import { invalidateLanes as realInvalidateLanes } from "./shadow-plugin.js";
import type { Slug } from "./types.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

/**
 * Durable checkpoint holding the epoch-ms high-water mark of the last successful
 * re-embed pass. Pages whose mtime is past this mark are re-chunked + re-embedded
 * into the section dense store; the mark is advanced only after a pass completes,
 * captured before the pass so a transient embed write does not re-trigger itself.
 * Distinct from `memory_v3_maintain_last_run` (the enqueue-cadence checkpoint in
 * `jobs-worker.ts`), which advances on every backstop enqueue rather than on an
 * actual maintenance run.
 */
const MAINTAIN_EMBED_HIGH_WATER_KEY =
  "memory_v3_maintain:enriched_through_ms" as const;

const log = getLogger("memory-v3-maintain");

/** Page-index projection the changed-page selector reads. */
export interface ChangedPageCandidate {
  slug: Slug;
  /** File mtime in epoch ms; 0 for synthetic skill/CLI rows (excluded). */
  modifiedAt: number;
}

/** Injectable collaborators; defaults wire the real implementations. */
export interface MaintainJobDeps {
  /**
   * The slugs whose sections to re-embed this pass: pages new or edited since
   * the last successful pass. See {@link computeChangedPages}.
   */
  selectChangedPages: () => Promise<Slug[]>;
  /** Re-chunk pages into the flat section index (pure; reads page bodies). */
  buildSectionIndex: typeof realBuildSectionIndex;
  /** Read a page's frontmatter-stripped body for `buildSectionIndex`. */
  readPageBody: (slug: Slug) => Promise<string>;
  /** Clear an article's stale section points before re-upserting. */
  deleteSectionsForArticle: typeof realDeleteSectionsForArticle;
  /** Embed + upsert an article's current sections into the dense store. */
  upsertSections: typeof realUpsertSections;
  /**
   * Persist the high-water mark after a successful re-embed pass. The value is
   * captured before the pass's writes (see the key docstring).
   */
  commitEmbedHighWater: (highWaterMs: number) => void;
  /** Drop the memoized v3 lanes so the next turn rebuilds them. */
  invalidateLanes: () => void;
  /** Active assistant config (for the dense-store/embedding calls). */
  config: AssistantConfig;
}

/**
 * Injectable collaborators for the one-time {@link backfillAllSections} pass.
 * Distinct from {@link MaintainJobDeps}: the backfill embeds EVERY page
 * (including synthetic capability rows the incremental selector excludes), so it
 * uses an all-pages selector, a capability-aware body reader, and an explicit
 * collection-ensure step rather than the change-delta machinery.
 */
export interface BackfillJobDeps {
  /** All page-index slugs, including synthetic skill/CLI capability rows. */
  selectAllPages: () => Promise<Slug[]>;
  /** Create the section collection if absent before the first upsert. */
  ensureSectionCollection: typeof realEnsureSectionCollection;
  /** Re-chunk pages into the flat section index (pure; reads page bodies). */
  buildSectionIndex: typeof realBuildSectionIndex;
  /** Read a page's body; capability slugs resolve their rendered content. */
  readPageBody: (slug: Slug) => Promise<string>;
  /** Clear an article's stale section points before re-upserting. */
  deleteSectionsForArticle: typeof realDeleteSectionsForArticle;
  /** Embed + upsert an article's current sections into the dense store. */
  upsertSections: typeof realUpsertSections;
  /** Persist the high-water mark after the backfill completes. */
  commitEmbedHighWater: (highWaterMs: number) => void;
  /** Epoch-ms stamped as the new high-water mark; injectable for tests. */
  nowMs: () => number;
  /** Active assistant config (for the dense-store/embedding calls). */
  config: AssistantConfig;
}

/** Counts surfaced by {@link backfillAllSections}. */
export interface BackfillOutcome {
  /** Pages whose sections were (re-)embedded this pass. */
  articles: number;
  /** Total section points upserted across all articles. */
  sections: number;
  /** Pages whose embed threw (and was contained). */
  failures: number;
}

/** Per-stage outcome surfaced in the structured log line. */
export interface MaintainOutcome {
  /** True when both v3 flags were off and the job no-opped. */
  disabled: boolean;
  /** Pages whose sections were re-chunked + re-embedded this pass. */
  reembedded: number;
  /** Pages whose re-embed threw (and was contained). */
  reembedFailures: number;
  /** Whether the in-memory lanes were invalidated. */
  invalidated: boolean;
  /** Stages that threw (and were contained). */
  failures: string[];
}

/**
 * Pick the pages the re-embed stage should refresh this pass: every page whose
 * mtime is past `prevHighWaterMs` (new or edited since the last successful run).
 * Synthetic skill/CLI rows (`modifiedAt === 0`) are excluded — they are
 * capability entries with no on-disk page to chunk. On the first run
 * (`prevHighWaterMs` null) every real page is selected so a fresh or
 * freshly-backfilled install seeds the section dense store once.
 */
export function computeChangedPages(
  pages: ReadonlyArray<ChangedPageCandidate>,
  prevHighWaterMs: number | null,
): Slug[] {
  const changed: Slug[] = [];
  for (const page of pages) {
    if (page.modifiedAt <= 0) continue; // synthetic capability row
    if (prevHighWaterMs === null || page.modifiedAt > prevHighWaterMs) {
      changed.push(page.slug);
    }
  }
  return changed;
}

/** Read the persisted high-water mark, treating missing/garbage as first-run. */
function readEmbedHighWater(): number | null {
  const raw = getMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Default selector: page index → {@link computeChangedPages}. */
async function selectChangedPagesFromWorkspace(
  workspaceDir: string,
): Promise<Slug[]> {
  const index = await getPageIndex(workspaceDir);
  return computeChangedPages(index.entries, readEmbedHighWater());
}

function commitEmbedHighWater(highWaterMs: number): void {
  setMemoryCheckpoint(MAINTAIN_EMBED_HIGH_WATER_KEY, String(highWaterMs));
}

/** Read a page's frontmatter-stripped body; missing/failed reads degrade to "". */
async function readPageBodyFromWorkspace(
  workspaceDir: string,
  slug: Slug,
): Promise<string> {
  try {
    const page = await readPage(workspaceDir, slug);
    return page?.body ?? "";
  } catch {
    return "";
  }
}

/**
 * Capability-aware page-body reader for the full backfill: synthetic skill/CLI
 * slugs have no on-disk page, so they contribute their rendered capability
 * content (exactly what `page-content.ts` injects for them) while real pages
 * read from disk. Mirrors `shadow-plugin.ts` `initLanes`' `pageBody`; the two
 * could later share a small helper.
 */
async function backfillPageBodyFromWorkspace(
  workspaceDir: string,
  slug: Slug,
): Promise<string> {
  if (isCapabilitySlug(slug)) return renderCapabilityContent(slug) ?? "";
  return readPageBodyFromWorkspace(workspaceDir, slug);
}

/** All page-index slugs, including synthetic skill/CLI capability rows. */
async function selectAllPagesFromWorkspace(
  workspaceDir: string,
): Promise<Slug[]> {
  const index = await getPageIndex(workspaceDir);
  return index.entries.map((entry) => entry.slug);
}

function defaultDeps(config: AssistantConfig): MaintainJobDeps {
  const workspaceDir = getWorkspaceDir();
  return {
    selectChangedPages: () => selectChangedPagesFromWorkspace(workspaceDir),
    buildSectionIndex: realBuildSectionIndex,
    readPageBody: (slug) => readPageBodyFromWorkspace(workspaceDir, slug),
    deleteSectionsForArticle: realDeleteSectionsForArticle,
    upsertSections: realUpsertSections,
    commitEmbedHighWater,
    invalidateLanes: realInvalidateLanes,
    config,
  };
}

function defaultBackfillDeps(config: AssistantConfig): BackfillJobDeps {
  const workspaceDir = getWorkspaceDir();
  return {
    selectAllPages: () => selectAllPagesFromWorkspace(workspaceDir),
    ensureSectionCollection: realEnsureSectionCollection,
    buildSectionIndex: realBuildSectionIndex,
    readPageBody: (slug) => backfillPageBodyFromWorkspace(workspaceDir, slug),
    deleteSectionsForArticle: realDeleteSectionsForArticle,
    upsertSections: realUpsertSections,
    commitEmbedHighWater,
    nowMs: () => Date.now(),
    config,
  };
}

/**
 * Re-chunk + re-embed each changed page into the section dense store. Each page
 * is refreshed independently: a single page whose delete/build/upsert throws is
 * logged and counted in `reembedFailures` without aborting the rest. Returns the
 * counts of successfully refreshed and failed pages.
 */
async function reembedChangedPages(
  slugs: Slug[],
  deps: MaintainJobDeps,
): Promise<{ reembedded: number; reembedFailures: number }> {
  let reembedded = 0;
  let reembedFailures = 0;
  for (const slug of slugs) {
    try {
      const index = await deps.buildSectionIndex([slug], deps.readPageBody);
      await deps.deleteSectionsForArticle(deps.config, slug);
      await deps.upsertSections(deps.config, index.sections);
      reembedded += 1;
    } catch (err) {
      reembedFailures += 1;
      log.warn(
        { slug, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 maintain: page re-embed failed (non-fatal)",
      );
    }
  }
  return { reembedded, reembedFailures };
}

/**
 * One-time full backfill of the section dense store. Unlike {@link maintainJob}
 * (which only re-embeds pages changed since the high-water mark and EXCLUDES
 * synthetic capability rows), this embeds EVERY page in the index — including
 * synthetic skill/CLI rows, whose `modifiedAt` is 0 and which the incremental
 * selector therefore never picks. It exists for the operator transition before
 * A/B/cutover: the `memory_v3_sections` collection starts empty, so on an
 * existing install most pages were never embedded into the dense lane.
 *
 * Each article is refreshed independently (delete its stale points, then
 * re-upsert its current sections); a single article whose build/delete/upsert
 * throws is logged and counted in `failures` without aborting the rest. After
 * the pass completes the high-water mark is advanced to the timestamp captured
 * BEFORE the pass, so the next incremental maintain run deltas from here instead
 * of re-embedding the whole corpus again. The timestamp is captured up-front (as
 * in `maintainJob`) so an embed write that bumps a page's mtime does not
 * re-trigger it next pass.
 */
export async function backfillAllSections(
  config: AssistantConfig,
  deps: BackfillJobDeps = defaultBackfillDeps(config),
): Promise<BackfillOutcome> {
  // Capture the high-water stamp before any writes (see the function docstring).
  const startedAtMs = deps.nowMs();

  const slugs = await deps.selectAllPages();
  await deps.ensureSectionCollection(deps.config);

  let articles = 0;
  let sections = 0;
  let failures = 0;
  for (const slug of slugs) {
    try {
      const index = await deps.buildSectionIndex([slug], deps.readPageBody);
      await deps.deleteSectionsForArticle(deps.config, slug);
      await deps.upsertSections(deps.config, index.sections);
      articles += 1;
      sections += index.sections.length;
    } catch (err) {
      failures += 1;
      log.warn(
        { slug, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 backfill: page embed failed (non-fatal)",
      );
    }
  }

  // Advance the maintain high-water mark so the next incremental pass deltas
  // from here rather than re-embedding everything.
  deps.commitEmbedHighWater(startedAtMs);

  log.info(
    { articles, sections, failures },
    "memory-v3 section backfill complete",
  );

  return { articles, sections, failures };
}

/**
 * Run the v3 self-maintenance pass. Each stage is independently contained: a
 * thrown error is logged and recorded in `failures` without aborting the rest.
 * No-ops when both v3 flags are off.
 */
export async function maintainJob(
  _job: MemoryJob,
  config: AssistantConfig,
  deps: MaintainJobDeps = defaultDeps(config),
): Promise<MaintainOutcome> {
  const outcome: MaintainOutcome = {
    disabled: false,
    reembedded: 0,
    reembedFailures: 0,
    invalidated: false,
    failures: [],
  };

  const enabled =
    isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config) ||
    isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
  if (!enabled) {
    outcome.disabled = true;
    return outcome;
  }

  // Stage 1: re-chunk + re-embed pages changed since the last pass. Capture the
  // high-water mark BEFORE the pass so an embed write that bumps a page's mtime
  // does not re-trigger it next pass; advance it only on success.
  try {
    const startedAtMs = Date.now();
    const changed = await deps.selectChangedPages();
    const { reembedded, reembedFailures } = await reembedChangedPages(
      changed,
      deps,
    );
    outcome.reembedded = reembedded;
    outcome.reembedFailures = reembedFailures;
    deps.commitEmbedHighWater(startedAtMs);
  } catch (err) {
    outcome.failures.push("reembed");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: section re-embed failed (non-fatal)",
    );
  }

  // Stage 2: rebuild section index + needle + edge graph on the next turn.
  try {
    deps.invalidateLanes();
    outcome.invalidated = true;
  } catch (err) {
    outcome.failures.push("invalidate");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: lane invalidation failed (non-fatal)",
    );
  }

  log.info(
    {
      reembedded: outcome.reembedded,
      reembedFailures: outcome.reembedFailures,
      invalidated: outcome.invalidated,
      failures: outcome.failures,
    },
    "memory-v3 maintain pass complete",
  );

  return outcome;
}
