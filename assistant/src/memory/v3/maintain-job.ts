/**
 * Memory v3 — `memory_v3_maintain` job handler.
 *
 * A flag-gated, best-effort self-maintenance pass over the v3 topic tree and
 * its page→leaf assignments. It runs three independent stages, in order:
 *
 *   1. **Classify-union** — `assignPages` over every page whose `leaves:`
 *      frontmatter is empty or missing, UNIONing freshly classified leaves into
 *      each page (never dropping existing picks).
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

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { MemoryJob } from "../jobs-store.js";
import { getPageIndex } from "../v2/page-index.js";
import { listPages, readPage, writePage } from "../v2/page-store.js";
import { assignPages as realAssignPages } from "./assign.js";
import { invalidateLanes as realInvalidateLanes } from "./shadow-plugin.js";
import { loadLeafTree as realLoadLeafTree, resolveDataDir } from "./tree.js";
import type { LeafPath, LeafTree, Slug } from "./types.js";

const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

const log = getLogger("memory-v3-maintain");

/** Injectable collaborators; defaults wire the real implementations. */
export interface MaintainJobDeps {
  /** Load the v3 leaf tree (page→leaf membership resolved from frontmatter). */
  loadTree: () => Promise<LeafTree>;
  /** Classify-union pass over pages. */
  assignPages: typeof realAssignPages;
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

function defaultDeps(): MaintainJobDeps {
  const workspaceDir = getWorkspaceDir();
  return {
    loadTree: () => loadTreeFromWorkspace(workspaceDir),
    assignPages: realAssignPages,
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
    // Stage 1: classify-union over unassigned pages.
    try {
      const results = await deps.assignPages({
        tree,
        workspaceDir: deps.workspaceDir,
      });
      outcome.assigned = results.filter(
        (r) => !r.failed && r.after.length > r.before.length,
      ).length;
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
