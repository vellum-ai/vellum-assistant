/**
 * Memory v3 — `memory_v3_maintain` job handler.
 *
 * A flag-gated, best-effort self-maintenance pass over the v3 section dense
 * store and the in-memory lanes. It runs six independent stages, in order:
 *
 *   1. **Section re-embed** — diff the page index by `modifiedAt` against the
 *      last successful pass (the high-water mark below), and for every page that
 *      is new or edited since then, re-chunk it into sections
 *      (`buildSectionIndex`) and refresh its dense points
 *      (`deleteSectionsForArticle` + `upsertSections`). This keeps the
 *      section-grain Qdrant collection in sync with on-disk page edits so the
 *      dense lane retrieves against current content. The high-water mark is
 *      advanced only after the pass completes with zero page failures (and is
 *      captured before any potential mtime bumps) so a page is not re-embedded
 *      forever, yet a page whose embed failed (and whose sections were therefore
 *      left deleted) stays above the mark and is retried next pass.
 *   2. **Capability reconcile** — embed capability rows (synthetic skill/CLI
 *      slugs) present in the page index but missing from the section store. The
 *      re-embed delta above EXCLUDES capability rows (they have `modifiedAt` 0,
 *      no mtime to diff), so the only other embedder is the one-time
 *      `backfillAllSections`. Without this stage a skill enabled AFTER that
 *      backfill (e.g. a flag-gated skill flipped on at runtime) lands in the
 *      index but never reaches the dense lane. See {@link reconcileCapabilityRows}.
 *   3. **Deleted-page prune** — diff the dense store's stored articles
 *      (`listSectionArticles`) against the live page-index slugs and
 *      `deleteSectionsForArticle` for any article that is no longer in the
 *      index. A deleted page's slug never reaches the re-embed delta selector
 *      (it only names live pages), so without this its section points would
 *      linger in Qdrant and the dense lane could still surface the deleted page.
 *      Synthetic capability rows are in the page index, so they are never pruned.
 *   4. **Core-set validation** — load the maintainer-curated core set
 *      (`memory/core-pages.md`) and report entries whose page no longer exists
 *      in the page index (dangling slugs) via the log + outcome. The file is
 *      maintainer-owned, so this stage NEVER edits it — the maintainer fixes
 *      dangling entries at the next consolidation pass.
 *   5. **Skill usage-prune (observe-first, default-off)** — REPORT
 *      assistant-authored managed skills unused for at least
 *      {@link SKILL_OBSERVE_WINDOW_DAYS} days (in `prunableSkills`) on every
 *      pass for observability, and DELETE them (via `executeDeleteManagedSkill`)
 *      only when `memory.maintenance.skillPruneDays` is a positive integer
 *      (default `null` = never prune). `author:"user"` and untagged skills are
 *      always protected. See {@link pruneStaleSkills}.
 *   6. **Lane invalidation** — `invalidateLanes()` so the next turn rebuilds the
 *      in-memory section index, needle, and edge graph from the freshly-updated
 *      pages.
 *
 * Best-effort by construction: each stage is wrapped so a failure in one is
 * logged and recorded in the outcome but does NOT abort the others. A single
 * page whose embed fails does not abort the rest of the re-embed stage, and a
 * single prune delete that throws does not abort the rest of the prune stage.
 * The job is a no-op (returns a disabled outcome) unless the `memory-v3-shadow`
 * flag OR `memory.v3.live` (config) is enabled — the same gates as the v3 plugin.
 *
 * Dependency-injectable: `deps` lets tests substitute the page-index reader,
 * section builder, dense-store ops (including the prune-stage
 * `listSectionArticles`/`listIndexedSlugs` collaborators), the core-set loader,
 * and `invalidateLanes` without process-global module mocks.
 */

import { isMemoryV3Live } from "../../../../config/memory-v3-gate.js";
import {
  loadSkillCatalog,
  type SkillSummary,
} from "../../../../config/skills.js";
import type { AssistantConfig } from "../../../../config/types.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { EmbeddingBackendUnavailableError } from "../../../../persistence/embeddings/embedding-backend.js";
import { EmbeddingBillingBlockError } from "../../../../persistence/embeddings/embedding-billing-breaker.js";
import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import {
  readInstallMeta,
  type SkillInstallMeta,
} from "../../../../skills/install-meta.js";
import { executeDeleteManagedSkill } from "../../../../tools/skills/delete-managed.js";
import { getLogger } from "../../../../util/logger.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { embedWithBackend } from "../embeddings.js";
import { getPageIndex } from "../v2/page-index.js";
import { readPage } from "../v2/page-store.js";
import { skillSlugFor } from "../v2/skill-store.js";
import { capabilityOrDiskBody, isCapabilitySlug } from "./capabilities.js";
import { loadCoreSet as realLoadCoreSet } from "./core-set.js";
import {
  deleteSectionsForArticle as realDeleteSectionsForArticle,
  ensureSectionCollection as realEnsureSectionCollection,
  listSectionArticles as realListSectionArticles,
  MAINTAIN_EMBED_HIGH_WATER_KEY,
  upsertSections as realUpsertSections,
} from "./section-dense-store.js";
import { buildSectionIndex as realBuildSectionIndex } from "./sections.js";
import { invalidateLanes as realInvalidateLanes } from "./shadow-plugin.js";
import type { Slug } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Age (in days) past which an assistant-authored managed skill is reported in
 * `prunableSkills`. This is the OBSERVE-ONLY window: it drives the report the
 * usage-prune stage emits on EVERY pass, independent of the delete threshold
 * (`memory.maintenance.skillPruneDays`). We ship deletion default-off and watch
 * this report to learn whether skills actually accumulate before enabling any
 * deletion.
 */
const SKILL_OBSERVE_WINDOW_DAYS = 30;

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
   * Establish the section collection before delta selection. Recreates it (and
   * clears the embed high-water) on absence or dimension drift, so a wiped
   * collection is observed by {@link selectChangedPages} and re-embedded in full
   * this pass rather than after a clobbered reset.
   */
  ensureSectionCollection: typeof realEnsureSectionCollection;
  /**
   * The slugs whose sections to re-embed this pass: pages new or edited since
   * the last successful pass. See {@link computeChangedPages}.
   */
  selectChangedPages: () => Promise<Slug[]>;
  /** Re-chunk pages into the flat section index (pure; reads page bodies). */
  buildSectionIndex: typeof realBuildSectionIndex;
  /** Read a page's frontmatter-stripped body for `buildSectionIndex`. */
  readPageBody: (slug: Slug) => Promise<string>;
  /**
   * Capability-aware body reader for the reconcile stage: synthetic skill/CLI
   * slugs resolve their rendered capability content; real pages read from disk.
   * The re-embed stage uses `readPageBody` (disk-only) since it only processes
   * real pages — the reconcile stage needs capability bodies.
   */
  readCapabilityBody: (slug: Slug) => Promise<string>;
  /** Clear an article's stale section points before re-upserting. */
  deleteSectionsForArticle: typeof realDeleteSectionsForArticle;
  /** Embed + upsert an article's current sections into the dense store. */
  upsertSections: typeof realUpsertSections;
  /**
   * Persist the high-water mark after a re-embed pass with zero failures. The
   * value is captured before the pass's writes (see the key docstring); the
   * caller skips this when any page failed so failed pages retry next pass.
   */
  commitEmbedHighWater: (highWaterMs: number) => void;
  /**
   * Every distinct `article` slug that currently has section points in the
   * dense store. The prune stage diffs this against the live page-index slugs
   * to find articles whose points linger after the page was deleted.
   */
  listSectionArticles: () => Promise<string[]>;
  /**
   * The slugs currently in the page index (the live set the lanes are rebuilt
   * from). The prune stage keeps these and deletes any section article absent
   * from this set. Includes synthetic capability rows so they are never pruned.
   */
  listIndexedSlugs: () => Promise<Slug[]>;
  /**
   * The maintainer-curated core set from `memory/core-pages.md`. The validation
   * stage diffs it against the live page-index slugs and REPORTS dangling
   * entries only — the file is maintainer-owned and is never edited here.
   */
  loadCoreSet: () => Slug[];
  /** Drop the memoized v3 lanes so the next turn rebuilds them. */
  invalidateLanes: () => void;
  /**
   * The managed (assistant-installed) skills in the catalog. The usage-prune
   * stage reads each one's install-meta to find stale assistant-authored skills.
   */
  listManagedSkills: () => SkillSummary[];
  /**
   * Read a skill's install metadata from its directory. The prune stage reads
   * `author`, `lastUsedAt`, and `installedAt` to decide eligibility.
   */
  readSkillMeta: (skillDir: string) => SkillInstallMeta | null;
  /**
   * Delete a managed skill by id (dir + companion files + graph node + v2
   * page/vectors + v3 sections reconcile), as the `delete_managed_skill` tool
   * does. Called only when deletion is enabled and a skill is stale.
   */
  deleteSkill: (skillId: string) => Promise<void>;
  /** Injected clock (epoch ms) for the usage-prune age math; testable. */
  nowMs: () => number;
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
  /**
   * All page-index slugs, including synthetic skill/CLI capability rows.
   * Called once at the start and once after the main loop — the second call
   * catches capability rows whose startup seed had not yet listed them in the
   * index when the first snapshot was taken.
   */
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
  /**
   * Persist the high-water mark after the backfill completes with zero
   * failures. Skipped when any page failed so failed pages retry next pass.
   */
  commitEmbedHighWater: (highWaterMs: number) => void;
  /** Epoch-ms stamped as the new high-water mark; injectable for tests. */
  nowMs: () => number;
  /** Active assistant config (for the dense-store/embedding calls). */
  config: AssistantConfig;
  /**
   * Smoke-test the embedding backend before any destructive write. Throws when
   * the backend is unavailable, so the backfill aborts BEFORE deleting any
   * article's points (each article is processed delete-then-upsert). Injectable
   * for tests.
   */
  embedProbe: () => Promise<void>;
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
  /**
   * Capability rows (skills/CLI) present in the index but missing from the
   * section store that were embedded this pass — how a skill enabled after the
   * one-time backfill reaches the dense lane (the re-embed delta excludes
   * capability rows).
   */
  capabilitiesReconciled: number;
  /** Capability reconcile embeds that threw (and were contained). */
  reconcileFailures: number;
  /**
   * Deleted-page articles whose lingering section points were pruned this pass
   * (present in the dense store but absent from the page index).
   */
  pruned: number;
  /** Prune deletes that threw (and were contained). */
  pruneFailures: number;
  /**
   * Core-set entries (`memory/core-pages.md`) whose page no longer exists in
   * the page index. Reported for the maintainer to fix at the next
   * consolidation pass — the file itself is never mutated.
   */
  danglingCoreSlugs: Slug[];
  /**
   * Assistant-authored managed skills actually deleted this pass by the
   * usage-prune stage. Always empty when deletion is disabled
   * (`memory.maintenance.skillPruneDays` is `null`).
   */
  prunedSkills: string[];
  /**
   * Observe-only report: assistant-authored managed skills unused (by
   * `lastUsedAt`, else `installedAt`) for at least {@link SKILL_OBSERVE_WINDOW_DAYS}
   * days. Reported on EVERY pass regardless of the delete threshold so skill
   * accumulation is visible before deletion is enabled. User-authored and
   * untagged skills are excluded.
   */
  prunableSkills: string[];
  /** Skill deletes that threw (and were contained). */
  skillPruneFailures: Array<{ skillId: string; error: string }>;
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
 * read from disk. Shares the capability-or-disk dispatch with `shadow-plugin.ts`
 * `initLanes`' `pageBody` via {@link capabilityOrDiskBody}.
 */
async function backfillPageBodyFromWorkspace(
  workspaceDir: string,
  slug: Slug,
): Promise<string> {
  return capabilityOrDiskBody(slug, (s) =>
    readPageBodyFromWorkspace(workspaceDir, s),
  );
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
    ensureSectionCollection: realEnsureSectionCollection,
    selectChangedPages: () => selectChangedPagesFromWorkspace(workspaceDir),
    buildSectionIndex: realBuildSectionIndex,
    readPageBody: (slug) => readPageBodyFromWorkspace(workspaceDir, slug),
    readCapabilityBody: (slug) =>
      backfillPageBodyFromWorkspace(workspaceDir, slug),
    deleteSectionsForArticle: realDeleteSectionsForArticle,
    upsertSections: realUpsertSections,
    commitEmbedHighWater,
    listSectionArticles: () => realListSectionArticles(config),
    listIndexedSlugs: () => selectAllPagesFromWorkspace(workspaceDir),
    loadCoreSet: () => realLoadCoreSet(workspaceDir),
    invalidateLanes: realInvalidateLanes,
    listManagedSkills: () =>
      loadSkillCatalog().filter((s) => s.source === "managed"),
    readSkillMeta: (skillDir) => readInstallMeta(skillDir),
    deleteSkill: async (skillId) => {
      const result = await executeDeleteManagedSkill(
        { skill_id: skillId },
        {
          conversationId: "memory-v3-maintain",
          workingDir: workspaceDir,
          trustClass: "guardian",
        },
      );
      if (result.isError) throw new Error(result.content);
    },
    nowMs: () => Date.now(),
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
    embedProbe: async () => {
      await embedWithBackend(["memory-v3 backfill preflight"]);
    },
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
 * Embed capability rows (synthetic skill/CLI slugs) present in the page index
 * but missing from the section dense store. The incremental re-embed selector
 * ({@link computeChangedPages}) excludes capability rows — they have no on-disk
 * mtime to delta against — so the ONLY other embedder is the one-time
 * {@link backfillAllSections}. Without this, a skill enabled AFTER that backfill
 * (e.g. a flag-gated skill flipped on at runtime) lands in the page index but
 * never reaches the dense lane. This stage makes the periodic maintain pass
 * self-heal: diff the live capability slugs against the stored section articles
 * and embed the missing ones.
 *
 * Each row is independent: a single build/upsert throw is logged and counted in
 * `reconcileFailures` without aborting the rest. A capability row whose body
 * resolves empty (its store has not seeded yet) is skipped WITHOUT deleting any
 * points — never replace good points with a blank — and is retried next pass.
 */
async function reconcileCapabilityRows(
  deps: MaintainJobDeps,
): Promise<{ capabilitiesReconciled: number; reconcileFailures: number }> {
  const [indexedSlugs, storedArticles] = await Promise.all([
    deps.listIndexedSlugs(),
    deps.listSectionArticles(),
  ]);
  const stored = new Set(storedArticles);
  const missing = indexedSlugs.filter(
    (slug) => isCapabilitySlug(slug) && !stored.has(slug),
  );

  let capabilitiesReconciled = 0;
  let reconcileFailures = 0;
  for (const slug of missing) {
    try {
      const body = await deps.readCapabilityBody(slug);
      if (body.trim().length === 0) continue; // store cold — retry next pass
      const index = await deps.buildSectionIndex(
        [slug],
        deps.readCapabilityBody,
      );
      await deps.deleteSectionsForArticle(deps.config, slug);
      await deps.upsertSections(deps.config, index.sections);
      capabilitiesReconciled += 1;
    } catch (err) {
      reconcileFailures += 1;
      log.warn(
        { slug, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 maintain: capability reconcile embed failed (non-fatal)",
      );
    }
  }
  return { capabilitiesReconciled, reconcileFailures };
}

/**
 * Prune section points for articles that no longer exist in the page index. A
 * deleted concept page leaves `getPageIndex` (so the needle and edge lanes both
 * drop it on the next rebuild) but its section points linger in Qdrant, where
 * the dense lane could still surface it. The incremental selector
 * ({@link computeChangedPages}) never names a slug that is gone, so a deleted
 * page's stale points are only reachable by reading the collection back and
 * diffing against the live slug set.
 *
 * Each deletion is independent: a single `deleteSectionsForArticle` throw is
 * logged and counted in `pruneFailures` without aborting the rest. Synthetic
 * capability rows are in the page index, so they are never pruned.
 */
async function pruneDeletedPages(
  deps: MaintainJobDeps,
): Promise<{ pruned: number; pruneFailures: number }> {
  const [storedArticles, indexedSlugs] = await Promise.all([
    deps.listSectionArticles(),
    deps.listIndexedSlugs(),
  ]);
  const live = new Set(indexedSlugs);
  const deleted = storedArticles.filter((article) => !live.has(article));

  let pruned = 0;
  let pruneFailures = 0;
  for (const article of deleted) {
    try {
      await deps.deleteSectionsForArticle(deps.config, article);
      pruned += 1;
    } catch (err) {
      pruneFailures += 1;
      log.warn(
        { article, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 maintain: deleted-page section prune failed (non-fatal)",
      );
    }
  }
  return { pruned, pruneFailures };
}

/**
 * Usage-based prune of assistant-authored managed skills — OBSERVE-FIRST and
 * DEFAULT-OFF. The retrospective stage authors/updates skills eagerly; this is
 * the backstop for skills that never recur. Two independent behaviors:
 *
 *   1. **Observe (always):** for every managed skill, read its install-meta and
 *      consider only `author === "assistant"` skills — `author:"user"` AND
 *      untagged legacy skills are protected and skipped. Reference time is
 *      `lastUsedAt ?? installedAt`; a skill whose age ≥
 *      {@link SKILL_OBSERVE_WINDOW_DAYS} is reported in `prunableSkills` EVERY
 *      pass, regardless of the delete threshold. This is the observability
 *      signal we watch before enabling deletion.
 *   2. **Delete (opt-in):** ONLY when `skillPruneDays` is a positive number does
 *      a skill whose age ≥ `skillPruneDays` get deleted via `deleteSkill`
 *      (recorded in `prunedSkills`). When `skillPruneDays` is `null` (the
 *      default) nothing is deleted.
 *
 * Each deletion is independent: a single `deleteSkill` rejection is recorded in
 * `skillPruneFailures` and the loop continues. The whole stage is wrapped by the
 * caller's try/catch per the job's contained-stage convention.
 */
async function pruneStaleSkills(deps: MaintainJobDeps): Promise<{
  prunedSkills: string[];
  prunableSkills: string[];
  skillPruneFailures: Array<{ skillId: string; error: string }>;
}> {
  const skillPruneDays = deps.config.memory.maintenance.skillPruneDays;
  const deleteEnabled =
    typeof skillPruneDays === "number" && skillPruneDays > 0;

  const managed = deps.listManagedSkills();
  const prunableSkills: string[] = [];
  const prunedSkills: string[] = [];
  const skillPruneFailures: Array<{ skillId: string; error: string }> = [];

  const now = deps.nowMs();
  let assistantAuthored = 0;

  for (const skill of managed) {
    const meta = deps.readSkillMeta(skill.directoryPath);
    // Protect user-authored AND untagged (legacy) skills — only the
    // assistant's own skills are ever eligible.
    if (meta?.author !== "assistant") continue;
    assistantAuthored += 1;

    const referenceTime = Date.parse(meta.lastUsedAt ?? meta.installedAt);
    if (Number.isNaN(referenceTime)) continue;
    const ageDays = (now - referenceTime) / DAY_MS;

    if (ageDays >= SKILL_OBSERVE_WINDOW_DAYS) {
      prunableSkills.push(skill.id);
    }

    if (deleteEnabled && ageDays >= skillPruneDays) {
      try {
        await deps.deleteSkill(skill.id);
        prunedSkills.push(skill.id);
      } catch (err) {
        skillPruneFailures.push({
          skillId: skill.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // Best-effort: clear the deleted skill's capability sections this pass.
      // The deleted-page prune already ran earlier in the job, and the dense
      // lane queries Qdrant without filtering on the live page index, so the
      // `skills/<id>` article could otherwise surface until a later pass. The
      // next pass's deleted-page prune is the backstop if this throws.
      try {
        await deps.deleteSectionsForArticle(
          deps.config,
          skillSlugFor(skill.id),
        );
      } catch (err) {
        log.warn(
          { err, skillId: skill.id },
          "memory-v3 maintain: skill section prune failed (non-fatal)",
        );
      }
    }
  }

  log.info(
    {
      managed: managed.length,
      assistantAuthored,
      prunable: prunableSkills.length,
      deleteEnabled,
      pruned: prunedSkills.length,
    },
    "memory-v3 maintain: skill usage-prune pass",
  );

  return { prunedSkills, prunableSkills, skillPruneFailures };
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
 * throws is logged and counted in `failures` without aborting the rest. When the
 * pass completes with zero failures the high-water mark is advanced to the
 * timestamp captured BEFORE the pass, so the next incremental maintain run
 * deltas from here instead of re-embedding the whole corpus again. The timestamp
 * is captured up-front (as in `maintainJob`) so an embed write that bumps a
 * page's mtime does not re-trigger it next pass. If any page failed the
 * checkpoint is held (not advanced): a failed page was delete-then-upsert'd and
 * so has no sections, and advancing past its mtime would hide it from the
 * incremental selector forever — holding the mark lets the next pass re-embed it.
 *
 * Capability rows get an extra guard. Their stores (skill/CLI caches) are
 * seeded fire-and-forget at daemon startup, so a backfill fired shortly after a
 * restart can race the seed in two ways: (a) the rows are missing from the page
 * index entirely when `selectAllPages` snapshots it, so they are silently
 * absent from the work list; (b) the rows are listed but their content cache is
 * still cold, so they render `""` — and the section chunker synthesizes a junk
 * one-line head section from the bare slug, which would be embedded as if it
 * were real content. Both end with capabilities effectively missing from the
 * dense lane while the pass reports zero failures. So: a capability row whose
 * body resolves empty is skipped without deleting its existing points (never
 * replace good points with a blank), the page index is re-enumerated after the
 * main loop (which spans long enough for the startup seed to finish) to pick up
 * late-appearing capability rows, cold rows are retried, and any capability row
 * that still resolves empty counts as a failure — holding the checkpoint and
 * surfacing in the outcome instead of silently succeeding.
 */
export async function backfillAllSections(
  config: AssistantConfig,
  deps: BackfillJobDeps = defaultBackfillDeps(config),
): Promise<BackfillOutcome> {
  // Capture the high-water stamp before any writes (see the function docstring).
  const startedAtMs = deps.nowMs();

  const slugs = await deps.selectAllPages();
  await deps.ensureSectionCollection(deps.config);

  // Pre-flight: smoke-test the embedding backend BEFORE any delete. Each article
  // is processed delete-then-upsert, so starting a full backfill against a down
  // backend would delete every article's points and re-embed none of them. A
  // throw here aborts with nothing deleted; the high-water mark stays put, so a
  // later run retries once the backend is healthy.
  await deps.embedProbe();

  let articles = 0;
  let sections = 0;
  let failures = 0;

  // "cold" is only reported for capability rows whose body resolves empty —
  // their store has not seeded yet. Real pages never report cold: an empty
  // on-disk body legitimately replaces the page's sections.
  const embedOne = async (
    slug: Slug,
  ): Promise<"embedded" | "cold" | "failed"> => {
    try {
      if (isCapabilitySlug(slug)) {
        const body = await deps.readPageBody(slug);
        if (body.trim().length === 0) return "cold";
      }
      const index = await deps.buildSectionIndex([slug], deps.readPageBody);
      await deps.deleteSectionsForArticle(deps.config, slug);
      await deps.upsertSections(deps.config, index.sections);
      articles += 1;
      sections += index.sections.length;
      return "embedded";
    } catch (err) {
      // A down embedding backend (unconfigured, or billing breaker open) fails
      // EVERY article — the condition is process-wide — and each article is
      // delete-then-upsert, so continuing would delete the rest of the corpus
      // and re-embed none of it. Abort the run; the high-water mark is never
      // advanced, so the next pass retries from here once the backend recovers.
      if (
        err instanceof EmbeddingBackendUnavailableError ||
        err instanceof EmbeddingBillingBlockError
      ) {
        throw err;
      }
      failures += 1;
      log.warn(
        { slug, err: err instanceof Error ? err.message : String(err) },
        "memory-v3 backfill: page embed failed (non-fatal)",
      );
      return "failed";
    }
  };

  const coldCapabilities: Slug[] = [];
  for (const slug of slugs) {
    if ((await embedOne(slug)) === "cold") coldCapabilities.push(slug);
  }

  // Late-capability sweep + cold retry. The main loop spans minutes on a real
  // corpus, so the startup-seeded capability stores have typically warmed by
  // now: re-enumerate the index to catch capability rows that were not listed
  // yet at snapshot time, and retry the ones that rendered cold. A row that
  // still resolves empty is a real failure.
  const processed = new Set(slugs);
  const lateCapabilities = (await deps.selectAllPages()).filter(
    (slug) => isCapabilitySlug(slug) && !processed.has(slug),
  );
  for (const slug of [...coldCapabilities, ...lateCapabilities]) {
    if ((await embedOne(slug)) === "cold") {
      failures += 1;
      log.warn(
        { slug },
        "memory-v3 backfill: capability row still empty after retry (capability store not seeded?) — re-run backfill-sections once the store seeds",
      );
    }
  }

  // Advance the maintain high-water mark only when every page embedded cleanly,
  // so the next incremental pass deltas from here rather than re-embedding
  // everything. A thrown failure was delete-then-upsert'd (it now has no
  // sections) and an empty capability row was never embedded at all; advancing
  // past them would hide them from `computeChangedPages` forever. Holding the
  // checkpoint keeps failed pages above the mark so the next pass re-embeds
  // them — re-embedding the succeeded pages too is idempotent and cheap.
  if (failures === 0) {
    deps.commitEmbedHighWater(startedAtMs);
  } else {
    log.info(
      { articles, sections, failures },
      "memory-v3 backfill: embed checkpoint held (page failures) — failed pages retry next pass",
    );
  }

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
    capabilitiesReconciled: 0,
    reconcileFailures: 0,
    pruned: 0,
    pruneFailures: 0,
    danglingCoreSlugs: [],
    prunedSkills: [],
    prunableSkills: [],
    skillPruneFailures: [],
    invalidated: false,
    failures: [],
  };

  const enabled = isMemoryV3Live(config);
  if (!enabled) {
    outcome.disabled = true;
    return outcome;
  }

  // Stage 1: re-chunk + re-embed pages changed since the last pass. Capture the
  // high-water mark BEFORE the pass so an embed write that bumps a page's mtime
  // does not re-trigger it next pass; advance it only when every page succeeded.
  try {
    const startedAtMs = Date.now();
    // Establish the collection BEFORE selecting deltas. If it is absent or
    // dimension-drifted, `ensureSectionCollection` recreates it empty and clears
    // the embed high-water; selecting deltas first would read the stale mark, so
    // this pass would re-embed only recent pages and then commit `startedAtMs`,
    // clobbering the reset and stranding the rest. Ensuring first makes the
    // cleared mark visible to `selectChangedPages`, turning this pass into the
    // full-corpus re-embed the recreate requires.
    await deps.ensureSectionCollection(deps.config);
    const changed = await deps.selectChangedPages();
    const { reembedded, reembedFailures } = await reembedChangedPages(
      changed,
      deps,
    );
    outcome.reembedded = reembedded;
    outcome.reembedFailures = reembedFailures;
    // Only advance the high-water mark when nothing failed. A failed page is
    // processed as delete-then-upsert, so a transient embed/Qdrant error leaves
    // its sections deleted; if we advanced past its mtime, `computeChangedPages`
    // would never re-select it (mtime <= high-water) and it would stay missing.
    // Holding the checkpoint keeps every failed page above the mark so it
    // retries next pass — the handful of already-succeeded pages re-embedding
    // again is idempotent and cheap.
    if (reembedFailures === 0) {
      deps.commitEmbedHighWater(startedAtMs);
    } else {
      log.info(
        { reembedded, reembedFailures },
        "memory-v3 maintain: embed checkpoint held (page failures) — failed pages retry next pass",
      );
    }
  } catch (err) {
    outcome.failures.push("reembed");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: section re-embed failed (non-fatal)",
    );
  }

  // Stage 2: embed capability rows (skills/CLI) present in the index but missing
  // from the section store. They have modifiedAt 0, so computeChangedPages never
  // selects them; the one-time backfill is otherwise their only embedder, so a
  // skill enabled after that backfill stays invisible to the dense lane until
  // this self-heals it. Contained: a failure is logged + recorded without
  // aborting later stages.
  try {
    const { capabilitiesReconciled, reconcileFailures } =
      await reconcileCapabilityRows(deps);
    outcome.capabilitiesReconciled = capabilitiesReconciled;
    outcome.reconcileFailures = reconcileFailures;
  } catch (err) {
    outcome.failures.push("capability-reconcile");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: capability reconcile failed (non-fatal)",
    );
  }

  // Stage 3: prune section points for pages deleted from the index. A deleted
  // page's slug never appears in `selectChangedPages` (the delta selector only
  // names live pages), so its lingering points are cleared by diffing the dense
  // store's stored articles against the live page-index slugs. Contained: a
  // failure is logged + recorded in `failures` without aborting invalidation.
  try {
    const { pruned, pruneFailures } = await pruneDeletedPages(deps);
    outcome.pruned = pruned;
    outcome.pruneFailures = pruneFailures;
  } catch (err) {
    outcome.failures.push("prune");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: deleted-page prune failed (non-fatal)",
    );
  }

  // Stage 4: validate the maintainer-curated core set. Diff `core-pages.md`
  // entries against the live page-index slugs and REPORT dangling entries
  // (pages that were renamed or deleted) through the log + outcome — the file
  // is maintainer-owned, so it is never auto-edited; the maintainer fixes it at
  // the next consolidation pass. No hot/core recompute is needed in this job:
  // the lanes (including the core and hot prefixes) are computed at lane init,
  // and the invalidateLanes() stage below already forces a next-turn rebuild —
  // that rebuild IS the consolidation-cadence refresh.
  try {
    const coreSlugs = deps.loadCoreSet();
    if (coreSlugs.length > 0) {
      const live = new Set(await deps.listIndexedSlugs());
      outcome.danglingCoreSlugs = coreSlugs.filter((slug) => !live.has(slug));
      if (outcome.danglingCoreSlugs.length > 0) {
        log.warn(
          { dangling: outcome.danglingCoreSlugs },
          "memory-v3 maintain: core-pages.md lists pages missing from the index — review the file at the next consolidation",
        );
      }
    }
  } catch (err) {
    outcome.failures.push("core-validate");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: core-set validation failed (non-fatal)",
    );
  }

  // Stage 5: usage-prune assistant-authored skills. OBSERVE-FIRST and
  // DEFAULT-OFF: it always REPORTS assistant-authored managed skills unused for
  // at least SKILL_OBSERVE_WINDOW_DAYS days (prunableSkills) so accumulation is
  // visible, and only DELETES — via executeDeleteManagedSkill — when
  // memory.maintenance.skillPruneDays is a positive integer (default null = never
  // prune). User-authored and untagged skills are always protected. Contained: a
  // failure is logged + recorded without aborting invalidation.
  try {
    const { prunedSkills, prunableSkills, skillPruneFailures } =
      await pruneStaleSkills(deps);
    outcome.prunedSkills = prunedSkills;
    outcome.prunableSkills = prunableSkills;
    outcome.skillPruneFailures = skillPruneFailures;
  } catch (err) {
    outcome.failures.push("skill-prune");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: skill usage-prune failed (non-fatal)",
    );
  }

  // Stage 6: rebuild section index + needle + edge graph on the next turn.
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
      capabilitiesReconciled: outcome.capabilitiesReconciled,
      reconcileFailures: outcome.reconcileFailures,
      pruned: outcome.pruned,
      pruneFailures: outcome.pruneFailures,
      danglingCoreSlugs: outcome.danglingCoreSlugs,
      prunedSkills: outcome.prunedSkills,
      prunableSkills: outcome.prunableSkills,
      skillPruneFailures: outcome.skillPruneFailures,
      invalidated: outcome.invalidated,
      failures: outcome.failures,
    },
    "memory-v3 maintain pass complete",
  );

  return outcome;
}
