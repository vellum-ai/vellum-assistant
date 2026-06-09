/**
 * Memory v3 — orchestrator composing the candidate lanes into one turn.
 *
 * Each turn runs:
 *   1. Candidate generation over three deterministic finder lanes:
 *        - the section-grain BM25 needle (`SectionNeedle.query`, KB articles),
 *        - the dense lane (`denseLane`, KD articles), and
 *        - link-graph edge expansion (`edgeExpand`) over the top needle+dense
 *          article seeds.
 *      Each lane only ever ADDS candidates, so the pool is recall-safe by
 *      construction.
 *   2. Build the candidate pool in CACHE ORDER: the stable prefix —
 *      `[...core (file order), ...hot (score order)]`, both computed at lane
 *      init — followed by the finder candidates (needle → dense → edge
 *      surfacing order). The stable prefix is identical across consecutive
 *      turns while the lanes are unchanged (lane invalidation at consolidation
 *      is the recompute cadence), so the selector input's leading segment can
 *      ride the provider KV cache.
 *
 *      Finder hits are deduped against the stable prefix for the POOL list
 *      (a slug never appears twice in the numbered candidate list), but a
 *      finder hit on a core/hot page KEEPS its matched-section ref in
 *      `matchedSections` and its entry in `lanes.finder` — so the selector
 *      tail and the section spotlight can still surface that page's CURRENT
 *      relevance even though the page itself sits in the stable prefix.
 *
 *      Per-candidate descriptors: a finder candidate carries its matched
 *      section's text (or the curated `links` description for an edge hit); a
 *      stable-prefix candidate carries its LEAD section's text — deliberately
 *      query-independent so the rendered prefix stays byte-identical across
 *      turns.
 *   3. A SINGLE forced-tool select (`selectPool`) over the whole pool. The
 *      result is this turn's selections — current turn only. There is no
 *      working-set union or eviction here anymore: cross-turn persistence is
 *      the injector's job (net-new blocks frozen into history), not a per-turn
 *      re-rendered carry set.
 */

import type { AssistantConfig } from "../../../config/schema.js";
import { denseLane } from "./dense.js";
import type { EdgeGraph } from "./edge.js";
import { edgeExpand } from "./edge.js";
import type { PoolCandidate } from "./pool-select.js";
import { selectPool } from "./pool-select.js";
import type { SectionNeedle } from "./section-needle.js";
import type {
  FinderLane,
  MemoryRoutingTurn,
  Section,
  SectionIndex,
  SelectedPage,
  Slug,
} from "./types.js";

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
  /** The curated core set in file order (existence-filtered at lane init).
   *  Heads the stable prefix of the candidate pool. */
  coreSlugs: Slug[];
  /** The frecency hot set in score order (computed at lane init with the core
   *  set excluded). Follows core in the stable prefix. */
  hotSlugs: Slug[];
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

/** A finder-lane candidate: the slug, the descriptor that justified it, and
 *  the finder lane that FIRST surfaced it (needle → dense → edge precedence). */
export interface FinderCandidate {
  slug: Slug;
  descriptor: string;
  lane: FinderLane;
}

/**
 * The three candidate lanes in cache order. `core` and `hot` are the stable
 * prefix (byte-identical across turns while lanes are unchanged); `finder` is
 * the dynamic tail and MAY repeat a stable-prefix slug (a finder hit on a
 * core/hot page is kept so its current relevance stays visible downstream).
 */
export interface OrchestrateLanes {
  /** Curated core set, file order. */
  core: Slug[];
  /** Frecency hot set, score order (never overlaps core). */
  hot: Slug[];
  /** Finder candidates in surfacing order, deduped among themselves only. */
  finder: FinderCandidate[];
}

export interface OrchestrateResult {
  /** This turn's selections, deduped by slug (pinned flags ORed). Current turn
   *  only — there is no carried-forward set unioned in. */
  selections: SelectedPage[];
  /** The matched `Section` for each candidate slug that had one, keyed by slug.
   *  Populated from the finder-lane hits — including hits on core/hot pages —
   *  and consumed by the injector to render each selected slug's matched
   *  section (progressive disclosure). */
  matchedSections: Map<Slug, Section>;
  /** The candidate lanes in cache order; see {@link OrchestrateLanes}. Consumed
   *  by the selection telemetry (lane attribution) and the downstream selector
   *  rendering/spotlight. */
  lanes: OrchestrateLanes;
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

  // The stable prefix: core (file order) then hot (score order). Hot is
  // computed with core excluded at lane init; the filter here is a cheap
  // defensive dedup so a misbehaving lane can never double-list a slug.
  const core = deps.coreSlugs;
  const hot = deps.hotSlugs.filter((slug) => !core.includes(slug));
  const stablePrefix = new Set<Slug>([...core, ...hot]);

  // Step 1: needle (sync BM25) and dense (async embed + Qdrant) lanes run in
  // parallel. Both return distinct articles each tagged with their best-scoring
  // section index/ordinal.
  const [needled, densed] = await Promise.all([
    Promise.resolve(deps.needle.query(turn.currentMessage, needleK)),
    denseLane(deps.denseConfig, turn.currentMessage, denseK),
  ]);

  // `matchedSections` records the matched `Section` (when one is known) for
  // every finder hit — INCLUDING hits on stable-prefix slugs — for downstream
  // injection/spotlight. `finder` accumulates one entry per distinct
  // finder-surfaced article; the first lane to surface a slug wins the entry,
  // so the needle → dense → edge call order encodes lane precedence.
  const matchedSections = new Map<Slug, Section>();
  const finder: FinderCandidate[] = [];
  const finderSeen = new Set<Slug>();

  // `descriptor` overrides the section text when supplied (the edge lane
  // prefers a curated `links` description).
  const addFinder = (
    slug: Slug,
    section: Section | undefined,
    descriptor: string | undefined,
    lane: FinderLane,
  ): void => {
    if (section && !matchedSections.has(slug)) {
      matchedSections.set(slug, section);
    }
    if (finderSeen.has(slug)) return;
    finderSeen.add(slug);
    finder.push({
      slug,
      descriptor: descriptor ?? section?.text ?? "",
      lane,
    });
  };

  // Step 1a: needle hits — descriptor is the matched section's text. `section`
  // is an index into `sections`.
  for (const hit of needled) {
    addFinder(hit.article, sections[hit.section], undefined, "needle");
  }

  // Step 1b: dense hits — `section` is the matched ORDINAL; resolve it to the
  // concrete `Section` via the section index. Falls back to undefined (blank
  // descriptor) if the ordinal is not in the in-memory index.
  for (const hit of densed) {
    // A deleted page's points can linger in Qdrant; keep only live-index
    // articles. The section index is rebuilt from `getPageIndex` at `initLanes`,
    // so `byArticle` holds exactly the live pages (synthetic capability slugs
    // included) — only truly-deleted pages are dropped here.
    if (!deps.sectionIndex.byArticle.has(hit.article)) continue;
    addFinder(
      hit.article,
      sectionByOrdinal(deps.sectionIndex, hit.article, hit.section),
      undefined,
      "dense",
    );
  }

  // Step 1c: edge expansion over the top needle+dense article seeds. `alive`
  // skips slugs already in the pool — finder-surfaced AND stable-prefix slugs
  // (an edge hit carries no matched section, so re-surfacing a core/hot page
  // adds nothing; needle/dense hits on those pages ARE kept for their
  // sections). An edge-only page was surfaced because its NEIGHBOUR matched —
  // the query did not lexically hit the page itself, so `bestSection` returns
  // its first/lead section on a zero-score match. That lead is often empty for
  // heading-structured pages, and it is the curated `links` description (not
  // the lead) that made the candidate relevant. So we record NO matched
  // section for edge-only pages (pass `undefined`), which makes injection fall
  // back to the FULL page — where the link-relevant content lives.
  // `bestSection`'s text is kept only as the select-pool DESCRIPTOR fallback
  // for when the traversed edge carried no curated `links` description.
  const seeds = unique<Slug>([
    ...needled.map((h) => h.article),
    ...densed.map((h) => h.article),
  ]);
  const surfaced = edgeExpand(deps.edgeGraph, seeds, {
    seedCount: deps.edgeSeeds,
    perSeed: deps.edgePerSeed,
    cap: deps.edgeCap,
    alive: (slug) => !finderSeen.has(slug) && !stablePrefix.has(slug),
  });
  for (const neighbor of surfaced) {
    const best = deps.needle.bestSection(neighbor.article, turn.currentMessage);
    const fallbackDescriptor = best >= 0 ? sections[best]?.text : undefined;
    addFinder(
      neighbor.article,
      undefined,
      neighbor.description ?? fallbackDescriptor,
      "edge",
    );
  }

  // Step 2: assemble the pool in cache order — stable prefix (core then hot)
  // first, then the finder tail deduped against the prefix. Stable-prefix
  // descriptors are the page's LEAD section text: query-INDEPENDENT by design,
  // so the rendered prefix is byte-identical across turns while the lanes are
  // unchanged.
  const pool: PoolCandidate[] = [
    ...[...core, ...hot].map((slug) => ({
      slug,
      descriptor: leadSectionText(deps.sectionIndex, slug),
    })),
    ...finder
      .filter((c) => !stablePrefix.has(c.slug))
      .map((c) => ({ slug: c.slug, descriptor: c.descriptor })),
  ];

  // Step 3: a SINGLE forced-tool select over the cache-ordered pool.
  const selected = await selectPool(pool, turn);
  const bySlug = new Map<Slug, SelectedPage>();
  for (const page of selected) {
    const existing = bySlug.get(page.slug);
    bySlug.set(page.slug, {
      slug: page.slug,
      pinned: (existing?.pinned ?? false) || page.pinned,
    });
  }

  return {
    selections: [...bySlug.values()],
    matchedSections,
    lanes: { core, hot, finder },
  };
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

/**
 * The text of an article's LEAD (first) section, or `""` when the article has
 * no indexed sections. Used as the stable-prefix candidates' descriptor: it
 * depends only on the page content, never on the turn's query, so the rendered
 * prefix stays byte-identical across turns.
 */
function leadSectionText(index: SectionIndex, article: Slug): string {
  const first = index.byArticle.get(article)?.[0];
  return first === undefined ? "" : (index.sections[first]?.text ?? "");
}
