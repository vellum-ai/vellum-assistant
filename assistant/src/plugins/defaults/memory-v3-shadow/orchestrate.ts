/**
 * Memory v3 — orchestrator composing the four routing lanes into one turn.
 *
 * Each turn runs:
 *   1. L1 topical routing (`routeL1`) and the lexical BM25 needle
 *      (`NeedleIndex.query`) IN PARALLEL. Routing is the slow LLM arm; the
 *      needle is a synchronous in-memory lookup, so we wrap it in a resolved
 *      promise and let them settle together.
 *   2. Open set = unique union of routed leaves ∪ always-on core leaves ∪ the
 *      leaves that own each needle hit. Every lane only ever ADDS leaves — the
 *      union is recall-safe by construction.
 *   3. Bounded per-leaf L2 selection (`selectAcrossLeaves`) over the open set,
 *      then dedup by slug (a page assigned to multiple opened leaves comes back
 *      once per leaf) ORing the pinned flag so a page pinned anywhere stays
 *      pinned.
 *   4. Age the carry-forward working set to this turn (evict core slugs, stale
 *      non-pinned entries, then the cap) and snapshot it — the pages carried in
 *      from EARLIER turns.
 *   5. Final injection = unique union of this turn's selected slugs and that
 *      carried-forward set, so pages selected on earlier turns carry forward
 *      even when this turn does not re-select them.
 *   6. Record this turn's selections into the working set for LATER turns. This
 *      runs AFTER the snapshot so the cap is spent on genuinely carried pages,
 *      not on this turn's selections (which are injected directly) — otherwise a
 *      turn selecting more pages than the cap would evict the entire carry.
 */

import type { NeedleIndex } from "./needle.js";
import { routeL1 } from "./router.js";
import type { SelectedPage } from "./selector.js";
import { selectAcrossLeaves } from "./selector.js";
import { coreSlugs, leavesOf } from "./tree.js";
import type { LeafPath, LeafTree, MemoryRoutingTurn, Slug } from "./types.js";
import { WorkingSet } from "./working-set.js";

/** Default number of needle hits to fold into the open set when unspecified. */
export const DEFAULT_NEEDLE_K = 10;

export interface OrchestrateDeps {
  tree: LeafTree;
  core: Set<LeafPath>;
  needle: NeedleIndex;
  workingSet: WorkingSet;
  pageSummary: (slug: Slug) => Promise<string>;
  /** Number of BM25 needle hits to fold in. Defaults to {@link DEFAULT_NEEDLE_K}. */
  needleK?: number;
  /** Bounded fan-out for per-leaf L2 selection. */
  l2Concurrency?: number;
}

export interface OrchestrateResult {
  /** The unique open set: routed ∪ core ∪ needle-owning leaves. */
  openedLeaves: LeafPath[];
  /** This turn's L2 selections, deduped by slug (pinned flags ORed). */
  currentSelections: SelectedPage[];
  /** The carried-forward set: selections from EARLIER turns, aged to this turn
   *  (snapshotted before this turn's selections are recorded). */
  workingSetUnion: Set<Slug>;
  /** Slugs to inject: this turn's selections ∪ the carried-forward working set. */
  finalInjection: Slug[];
}

/** Stable-order de-duplication preserving first occurrence. */
function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export async function orchestrate(
  turn: MemoryRoutingTurn,
  deps: OrchestrateDeps,
): Promise<OrchestrateResult> {
  // Step 1: routing (LLM) and needle (sync BM25) run in parallel.
  const needleK = deps.needleK ?? DEFAULT_NEEDLE_K;
  const [routed, needled] = await Promise.all([
    routeL1(turn, deps.tree),
    Promise.resolve(deps.needle.query(turn.currentMessage, needleK)),
  ]);

  // Step 2: open set = routed ∪ core ∪ leaves owning each needle hit.
  const openedLeaves = unique<LeafPath>([
    ...routed,
    ...deps.core,
    ...needled.flatMap((slug) => leavesOf(deps.tree, slug)),
  ]);

  // Step 3: per-leaf L2 selection, then dedup by slug ORing pinned flags.
  const selected = await selectAcrossLeaves(
    openedLeaves,
    turn,
    deps.tree,
    deps.pageSummary,
    deps.l2Concurrency,
  );
  const bySlug = new Map<Slug, SelectedPage>();
  for (const page of selected) {
    const existing = bySlug.get(page.slug);
    bySlug.set(page.slug, {
      slug: page.slug,
      pinned: (existing?.pinned ?? false) || page.pinned,
    });
  }
  const currentSelections = [...bySlug.values()];

  // Step 4: age the carry-forward set to this turn (drop core slugs, stale
  // non-pinned entries, then the cap) and snapshot it. This is the set carried
  // in from EARLIER turns; recording this turn happens afterward (step 6) so the
  // cap is spent on genuinely carried pages, not on this turn's selections
  // (which are injected directly anyway).
  deps.workingSet.evict(turn.turnNumber, coreSlugs(deps.tree, deps.core));
  const workingSetUnion = deps.workingSet.union();

  // Step 5: final injection = this turn's selections ∪ the carried-forward set,
  // so pages selected on earlier turns carry forward even when this turn does
  // not re-select them.
  const finalInjection = unique<Slug>([
    ...currentSelections.map((s) => s.slug),
    ...workingSetUnion,
  ]);

  // Step 6: record this turn's selections so they carry forward to LATER turns.
  for (const sel of currentSelections) {
    deps.workingSet.recordSelection(sel.slug, turn.turnNumber, sel.pinned);
  }

  return { openedLeaves, currentSelections, workingSetUnion, finalInjection };
}
