/**
 * Memory v3 — orchestrator composing the section-grain lanes into one turn.
 *
 * Each turn runs:
 *   1. Candidate generation over three deterministic lanes:
 *        - the section-grain BM25 needle (`SectionNeedle.query`, KB articles),
 *        - the dense lane (`denseLane`, KD articles), and
 *        - link-graph edge expansion (`edgeExpand`) over the top needle+dense
 *          article seeds.
 *      Each lane only ever ADDS candidates, so the pool is recall-safe by
 *      construction.
 *   2. Build the unified candidate pool of `{ slug, descriptor }`. The
 *      descriptor is the matched section's text for needle/dense hits (resolved
 *      via the section index); for edge-only pages it is the curated `links`
 *      description when the traversed edge carried one, else the page's best
 *      section against the query. The synthetic capability slugs (skills / CLI
 *      commands) are always appended (lane-ranking of synthetic pages is a
 *      documented fast-follow).
 *   3. A SINGLE forced-tool select (`selectPool`) over the whole pool. The
 *      result is this turn's selections.
 *   4. Age the carry-forward working set to this turn (evict stale non-pinned
 *      entries, then the cap) and snapshot it — the pages carried in from
 *      EARLIER turns.
 *   5. Final injection = unique union of this turn's selected slugs and that
 *      carried-forward set, so pages selected on earlier turns carry forward
 *      even when this turn does not re-select them.
 *   6. Record this turn's selections into the working set for LATER turns. This
 *      runs AFTER the snapshot so the cap is spent on genuinely carried pages,
 *      not on this turn's selections (which are injected directly) — otherwise a
 *      turn selecting more pages than the cap would evict the entire carry.
 */

import type { AssistantConfig } from "../../../config/schema.js";
import { denseLane } from "./dense.js";
import type { EdgeGraph } from "./edge.js";
import { edgeExpand } from "./edge.js";
import type { PoolCandidate } from "./pool-select.js";
import { selectPool } from "./pool-select.js";
import type { SectionNeedle } from "./section-needle.js";
import type {
  MemoryRoutingTurn,
  Section,
  SectionIndex,
  SelectedPage,
  Slug,
} from "./types.js";
import { WorkingSet } from "./working-set.js";

/** Default number of BM25 needle articles to fold into the pool. */
export const DEFAULT_NEEDLE_K = 100;
/** Default number of dense-lane articles to fold into the pool. */
export const DEFAULT_DENSE_K = 100;

export interface OrchestrateDeps {
  sectionIndex: SectionIndex;
  needle: SectionNeedle;
  /** Config the dense lane needs to embed the query + search the section
   *  collection. */
  denseConfig: AssistantConfig;
  edgeGraph: EdgeGraph;
  workingSet: WorkingSet;
  /** Synthetic capability slugs (skills / CLI commands) always added to the
   *  pool. Lane-ranking of synthetic pages is a documented fast-follow. */
  capabilitySlugs: Slug[];
  /** Number of BM25 needle articles. Defaults to {@link DEFAULT_NEEDLE_K}. */
  needleK?: number;
  /** Number of dense-lane articles. Defaults to {@link DEFAULT_DENSE_K}. */
  denseK?: number;
  /** Number of top needle+dense seeds expanded. When omitted, the edge lane's
   *  own default applies (canonical value: `memory.v3.edge.seedCount`). */
  edgeSeeds?: number;
  /** Neighbours surfaced per expanded edge seed. When omitted, the edge lane's
   *  own default applies (canonical value: `memory.v3.edge.perSeed`). */
  edgePerSeed?: number;
  /** Hard cap on total edge-lane surfaced articles. When omitted, the edge
   *  lane's own default applies (canonical value: `memory.v3.edge.cap`). */
  edgeCap?: number;
}

export interface OrchestrateResult {
  /** This turn's selections, deduped by slug (pinned flags ORed). */
  currentSelections: SelectedPage[];
  /** The carried-forward set: selections from EARLIER turns, aged to this turn
   *  (snapshotted before this turn's selections are recorded). */
  workingSetUnion: Set<Slug>;
  /** Slugs to inject: this turn's selections ∪ the carried-forward working set. */
  finalInjection: Slug[];
  /** The matched `Section` for each pooled slug that had one, keyed by slug.
   *  Populated from the lane hits and consumed by the injector to render each
   *  selected slug's matched section (progressive disclosure). */
  sectionBySlug: Map<Slug, Section>;
}

/** Stable-order de-duplication preserving first occurrence. */
function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export async function orchestrate(
  turn: MemoryRoutingTurn,
  deps: OrchestrateDeps,
): Promise<OrchestrateResult> {
  const needleK = deps.needleK ?? DEFAULT_NEEDLE_K;
  const denseK = deps.denseK ?? DEFAULT_DENSE_K;
  const { sections } = deps.sectionIndex;

  // Step 1: needle (sync BM25) and dense (async embed + Qdrant) lanes run in
  // parallel. Both return distinct articles each tagged with their best-scoring
  // section index/ordinal.
  const [needled, densed] = await Promise.all([
    Promise.resolve(deps.needle.query(turn.currentMessage, needleK)),
    denseLane(deps.denseConfig, turn.currentMessage, denseK),
  ]);

  // The pool accumulates one entry per distinct article. `sectionBySlug` records
  // the matched `Section` (when one is known) for downstream injection.
  const poolBySlug = new Map<Slug, PoolCandidate>();
  const sectionBySlug = new Map<Slug, Section>();

  // Add one pool candidate, recording its matched `Section` (when known) for
  // downstream injection. `descriptor` overrides the section text when supplied
  // (the edge lane prefers a curated `links` description). The first lane to
  // surface a slug wins both the pool entry and the recorded section.
  const addCandidate = (
    slug: Slug,
    section: Section | undefined,
    descriptor?: string,
  ): void => {
    if (section && !sectionBySlug.has(slug)) {
      sectionBySlug.set(slug, section);
    }
    if (poolBySlug.has(slug)) return;
    poolBySlug.set(slug, {
      slug,
      descriptor: descriptor ?? section?.text ?? "",
    });
  };

  // Step 2a: needle hits — descriptor is the matched section's text. `section`
  // is an index into `sections`.
  for (const hit of needled) {
    addCandidate(hit.article, sections[hit.section]);
  }

  // Step 2b: dense hits — `section` is the matched ORDINAL; resolve it to the
  // concrete `Section` via the section index. Falls back to undefined (blank
  // descriptor) if the ordinal is not in the in-memory index.
  for (const hit of densed) {
    addCandidate(
      hit.article,
      sectionByOrdinal(deps.sectionIndex, hit.article, hit.section),
    );
  }

  // Step 2c: edge expansion over the top needle+dense article seeds. Each
  // surfaced article prefers its curated `links` description; else its best
  // section against the query. `alive` skips slugs already pooled.
  const seeds = unique<Slug>([
    ...needled.map((h) => h.article),
    ...densed.map((h) => h.article),
  ]);
  const surfaced = edgeExpand(deps.edgeGraph, seeds, {
    seedCount: deps.edgeSeeds,
    perSeed: deps.edgePerSeed,
    cap: deps.edgeCap,
    alive: (slug) => !poolBySlug.has(slug),
  });
  for (const neighbor of surfaced) {
    const best = deps.needle.bestSection(neighbor.article, turn.currentMessage);
    const section = best >= 0 ? sections[best] : undefined;
    addCandidate(neighbor.article, section, neighbor.description);
  }

  // Step 2d: always-add the synthetic capability slugs (skills / CLI commands)
  // with a blank descriptor — they have no matched section. Proper lane-ranking
  // of synthetic pages is a documented fast-follow.
  for (const slug of deps.capabilitySlugs) {
    addCandidate(slug, undefined);
  }

  // Step 3: a SINGLE forced-tool select over the unified pool.
  const selected = await selectPool([...poolBySlug.values()], turn);
  const bySlug = new Map<Slug, SelectedPage>();
  for (const page of selected) {
    const existing = bySlug.get(page.slug);
    bySlug.set(page.slug, {
      slug: page.slug,
      pinned: (existing?.pinned ?? false) || page.pinned,
    });
  }
  const currentSelections = [...bySlug.values()];

  // Step 4: age the carry-forward set to this turn (drop stale non-pinned
  // entries, then the cap) and snapshot it. This is the set carried in from
  // EARLIER turns; recording this turn happens afterward (step 6) so the cap is
  // spent on genuinely carried pages, not on this turn's selections (which are
  // injected directly anyway).
  deps.workingSet.evict(turn.turnNumber);
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

  return { currentSelections, workingSetUnion, finalInjection, sectionBySlug };
}

/**
 * Resolve a dense-lane hit's matched ordinal to the concrete `Section` in the
 * in-memory index. The dense store keys sections by `(article, ordinal)`, so we
 * scan the article's sections for the matching ordinal. Returns `undefined`
 * when the article or ordinal is not in the index (e.g. the dense store is
 * ahead of the in-memory rebuild).
 */
function sectionByOrdinal(
  index: SectionIndex,
  article: Slug,
  ordinal: number,
): Section | undefined {
  const indices = index.byArticle.get(article);
  if (!indices) return undefined;
  for (const i of indices) {
    const section = index.sections[i];
    if (section && section.ordinal === ordinal) return section;
  }
  return undefined;
}
