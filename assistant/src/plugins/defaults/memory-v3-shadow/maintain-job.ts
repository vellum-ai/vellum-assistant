/**
 * Memory v3 — `memory_v3_maintain` job handler.
 *
 * A flag-gated, best-effort self-maintenance pass over the v3 topic tree and
 * its page→leaf assignments. It runs three independent stages, in order:
 *
 *   1. **Classify-union** — `assignPages` over the delta: every page that is
 *      still unassigned (empty `leaves:`) plus every page edited since the last
 *      successful pass (the high-water mark below), UNIONing freshly classified
 *      leaves into each page (never dropping existing picks). Re-touching
 *      already-assigned-but-recently-edited pages lets the classifier enrich the
 *      assistant's own in-consolidation labels with any leaves it missed.
 *   2. **Prune** — drop any frontmatter `leaves:` entry that points at a leaf
 *      path no longer present in the tree (dangling references left behind when
 *      a leaf is renamed or removed). Read + rewrite only the affected pages.
 *   3. **Needle rebuild** — `invalidateLanes()` so the next turn rebuilds the
 *      leaf tree and BM25 needle from the freshly-updated assignments.
 *
 * Best-effort by construction: each stage is wrapped so a failure in one is
 * logged and recorded in the outcome but does NOT abort the others. The job is
 * a no-op (returns a disabled outcome) unless `memory-v3-shadow` OR
 * `memory-v3-live` is enabled — the same flags that gate the v3 plugin.
 *
 * Dependency-injectable: `deps` lets tests substitute the tree loader,
 * `assignPages`, and `invalidateLanes` without process-global module mocks.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../../config/types.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../memory/checkpoints.js";
import type { MemoryJob } from "../../../memory/jobs-store.js";
import { getPageIndex } from "../../../memory/v2/page-index.js";
import {
  listPages,
  readPage,
  writePage,
} from "../../../memory/v2/page-store.js";
import { getLogger } from "../../../util/logger.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { assignPages as realAssignPages } from "./assign.js";
import { invalidateLanes as realInvalidateLanes } from "./shadow-plugin.js";
import { loadLeafTree as realLoadLeafTree, resolveDataDir } from "./tree.js";
import type { LeafPath, LeafTree, Slug } from "./types.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

/**
 * Durable checkpoint holding the epoch-ms high-water mark of the last successful
 * classify-union pass. Pages whose mtime is past this mark are re-classified
 * (enrichment); the mark is advanced only after a pass completes, captured after
 * its writes so the pass's own frontmatter rewrites do not re-trigger it.
 * Distinct from `memory_v3_maintain_last_run` (the enqueue-cadence checkpoint in
 * `jobs-worker.ts`), which advances on every backstop enqueue rather than on an
 * actual maintenance run.
 */
const MAINTAIN_ENRICH_HIGH_WATER_KEY =
  "memory_v3_maintain:enriched_through_ms" as const;

const log = getLogger("memory-v3-maintain");

/** Injectable collaborators; defaults wire the real implementations. */
export interface MaintainJobDeps {
  /** Load the v3 leaf tree (page→leaf membership resolved from frontmatter). */
  loadTree: () => Promise<LeafTree>;
  /** Classify-union pass over pages. */
  assignPages: typeof realAssignPages;
  /**
   * The slugs to classify this pass: unassigned pages plus pages edited since
   * the last successful pass. See {@link computeClassifyTargets}.
   */
  selectClassifyTargets: () => Promise<Slug[]>;
  /**
   * Persist the enrichment high-water mark after a successful classify pass. The
   * value is captured after the pass's writes (see the key docstring).
   */
  commitClassifyHighWater: (highWaterMs: number) => void;
  /** Drop the memoized v3 lanes so the next turn rebuilds tree + needle. */
  invalidateLanes: () => void;
  /** Workspace root; pages live under `<workspaceDir>/memory/concepts/`. */
  workspaceDir: string;
}

/** Per-stage outcome surfaced in the structured log line. */
export interface MaintainOutcome {
  /** True when both v3 flags were off and the job no-opped. */
  disabled: boolean;
  /** Pages newly assigned by the classify-union stage. */
  assigned: number;
  /** Pages whose dangling refs were pruned. */
  pruned: number;
  /** Dangling leaf references dropped across all pruned pages. */
  prunedRefs: number;
  /** Whether the needle/tree lanes were invalidated. */
  invalidated: boolean;
  /** Stages that threw (and were contained). */
  failures: string[];
}

/**
 * Load the v3 leaf tree the same way the live plugin does: resolve the data
 * dir, build the page→leaf membership map from the page index frontmatter, and
 * hand both to `loadLeafTree`.
 */
async function loadTreeFromWorkspace(workspaceDir: string): Promise<LeafTree> {
  const pageIndex = await getPageIndex(workspaceDir);
  const pageLeaves = new Map<Slug, LeafPath[]>();
  for (const entry of pageIndex.entries) {
    pageLeaves.set(entry.slug, entry.leaves);
  }
  return realLoadLeafTree(resolveDataDir(), pageLeaves);
}

/** Page-index projection the classify-target selector reads. */
export interface ClassifyCandidate {
  slug: Slug;
  /** File mtime in epoch ms; 0 for synthetic skill/CLI rows (excluded). */
  modifiedAt: number;
  /** Leaf assignments from frontmatter; `[]` when unassigned. */
  leaves: LeafPath[];
}

/**
 * Pick the pages the classify-union stage should run this pass:
 *
 *  - **Unassigned** pages (empty `leaves:`) — always classified so a page is
 *    never left permanently unrouted (the pre-enrichment behavior).
 *  - **Recently edited** pages (mtime past `prevHighWaterMs`) — even when
 *    already assigned, so the classifier can enrich the assistant's own
 *    in-consolidation labels with leaves it missed. `assignPages` UNIONs, so a
 *    page's existing picks are never dropped — only added to.
 *
 * Synthetic skill/CLI rows (`modifiedAt === 0`) are excluded: they are
 * capability entries, not topic-tree pages. On the first run (`prevHighWaterMs`
 * null) the recency arm is disabled, so a fresh or freshly-backfilled install
 * does a single unassigned-only pass instead of re-classifying the whole corpus.
 */
export function computeClassifyTargets(
  pages: ReadonlyArray<ClassifyCandidate>,
  prevHighWaterMs: number | null,
): Slug[] {
  const targets: Slug[] = [];
  for (const page of pages) {
    if (page.modifiedAt <= 0) continue; // synthetic capability row
    const unassigned = page.leaves.length === 0;
    const recentlyEdited =
      prevHighWaterMs !== null && page.modifiedAt > prevHighWaterMs;
    if (unassigned || recentlyEdited) targets.push(page.slug);
  }
  return targets;
}

/** Read the persisted high-water mark, treating missing/garbage as first-run. */
function readClassifyHighWater(): number | null {
  const raw = getMemoryCheckpoint(MAINTAIN_ENRICH_HIGH_WATER_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Default target selector: page index → {@link computeClassifyTargets}. */
async function selectClassifyTargetsFromWorkspace(
  workspaceDir: string,
): Promise<Slug[]> {
  const index = await getPageIndex(workspaceDir);
  return computeClassifyTargets(index.entries, readClassifyHighWater());
}

function commitClassifyHighWater(highWaterMs: number): void {
  setMemoryCheckpoint(MAINTAIN_ENRICH_HIGH_WATER_KEY, String(highWaterMs));
}

function defaultDeps(): MaintainJobDeps {
  const workspaceDir = getWorkspaceDir();
  return {
    loadTree: () => loadTreeFromWorkspace(workspaceDir),
    assignPages: realAssignPages,
    selectClassifyTargets: () =>
      selectClassifyTargetsFromWorkspace(workspaceDir),
    commitClassifyHighWater,
    invalidateLanes: realInvalidateLanes,
    workspaceDir,
  };
}

/**
 * Prune dangling `leaves:` references: for every page, drop frontmatter leaf
 * paths that are not present in `tree`. Read + rewrite only pages that actually
 * change. Returns the number of pages rewritten and total refs dropped.
 */
async function prunePages(
  tree: LeafTree,
  workspaceDir: string,
): Promise<{ pruned: number; prunedRefs: number }> {
  const validLeaves = tree.leaves;
  const slugs = await listPages(workspaceDir);
  let pruned = 0;
  let prunedRefs = 0;
  for (const slug of slugs) {
    const page = await readPage(workspaceDir, slug);
    const leaves = page?.frontmatter.leaves;
    if (!page || !leaves || leaves.length === 0) continue;
    const kept = leaves.filter((leaf) => validLeaves.has(leaf));
    if (kept.length === leaves.length) continue;
    prunedRefs += leaves.length - kept.length;
    pruned += 1;
    await writePage(workspaceDir, {
      ...page,
      frontmatter: { ...page.frontmatter, leaves: kept },
    });
  }
  return { pruned, prunedRefs };
}

/**
 * Run the v3 self-maintenance pass. Each stage is independently contained: a
 * thrown error is logged and recorded in `failures` without aborting the rest.
 * No-ops when both v3 flags are off.
 */
export async function maintainJob(
  _job: MemoryJob,
  config: AssistantConfig,
  deps: MaintainJobDeps = defaultDeps(),
): Promise<MaintainOutcome> {
  const outcome: MaintainOutcome = {
    disabled: false,
    assigned: 0,
    pruned: 0,
    prunedRefs: 0,
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

  // The tree is shared input for both the assign and prune stages. If it can't
  // load, those two stages are skipped (recorded as a failure), but we still
  // invalidate the lanes so a transient load error doesn't wedge the next turn.
  let tree: LeafTree | null = null;
  try {
    tree = await deps.loadTree();
  } catch (err) {
    outcome.failures.push("load_tree");
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "memory-v3 maintain: tree load failed (non-fatal)",
    );
  }

  if (tree) {
    // Stage 1: classify-union over the delta (unassigned ∪ recently-edited).
    try {
      const targets = await deps.selectClassifyTargets();
      const results = await deps.assignPages({
        tree,
        workspaceDir: deps.workspaceDir,
        slugs: targets,
      });
      outcome.assigned = results.filter(
        (r) => !r.failed && r.after.length > r.before.length,
      ).length;
      // Advance the high-water mark only on success, captured AFTER the writes
      // above so pages this pass just rewrote (mtime now bumped) sit at-or-below
      // the mark and do not re-trigger themselves next pass.
      deps.commitClassifyHighWater(Date.now());
    } catch (err) {
      outcome.failures.push("assign");
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "memory-v3 maintain: classify-union failed (non-fatal)",
      );
    }

    // Stage 2: prune dangling refs.
    try {
      const { pruned, prunedRefs } = await prunePages(tree, deps.workspaceDir);
      outcome.pruned = pruned;
      outcome.prunedRefs = prunedRefs;
    } catch (err) {
      outcome.failures.push("prune");
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "memory-v3 maintain: prune failed (non-fatal)",
      );
    }
  }

  // Stage 3: rebuild tree + needle on the next turn.
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
      assigned: outcome.assigned,
      pruned: outcome.pruned,
      prunedRefs: outcome.prunedRefs,
      invalidated: outcome.invalidated,
      failures: outcome.failures,
    },
    "memory-v3 maintain pass complete",
  );

  return outcome;
}
