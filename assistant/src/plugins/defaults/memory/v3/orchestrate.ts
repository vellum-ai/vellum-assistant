/**
 * Memory v3 — orchestrator composing the candidate lanes into one turn.
 *
 * Each turn runs:
 *   1. Candidate generation over the deterministic finder lanes:
 *        - the section-grain BM25 needle (`SectionNeedle.query`, KB articles),
 *        - the dense lane (`denseLane`, KD articles),
 *        - the reply-query pass — needle + dense re-run over the assistant's
 *          PREVIOUS message as separate queries at a smaller budget
 *          (`replyQueryK` per lane), surfacing the threads the assistant is
 *          actively developing that the user's message references without
 *          naming — and
 *        - link-graph edge expansion (`edgeExpand`) over the top
 *          user-message needle+dense article seeds, and
 *        - learned-edge expansion (`edgeExpand` over the co-selection NPMI
 *          graph from `learned-edges.ts`) over the same seeds — behavioral
 *          associations the authored link graph does not record.
 *      Each lane only ever ADDS candidates, so the pool is recall-safe by
 *      construction.
 *   1b. OPT-IN injection gate (`deps.gateConfig.enabled`, default off): once the
 *      CURRENT-message finder lanes have run, `checkV3Gate` scores the needle +
 *      dense hits against the tuned thresholds. A closed gate skips the
 *      selectPool LLM call for the turn — returning empty selections (or, when
 *      `bypassForCore` is set, running selectPool over the stable prefix only) —
 *      so a low-signal turn pays no selector cost. The gate is pass-open: any
 *      throw inside it logs a warning and falls through to normal selection.
 *   2. Build the candidate pool in CACHE ORDER: the stable prefix —
 *      `[...core (file order), ...hot (score order), ...fresh (recency order),
 *      ...always-candidate (skills pinned every turn)]`, all computed at lane
 *      init — followed by the finder candidates (needle → dense → edge
 *      surfacing order). The stable prefix
 *      is identical across consecutive turns while the lanes are unchanged
 *      (lane invalidation at consolidation is the recompute cadence), so the
 *      selector input's leading segment rides the provider KV cache (the
 *      cache breakpoint itself lives in `pool-select.ts`).
 *
 *      Stable-prefix candidates render as FULL CARDS (`renderCard` — head
 *      section + TOC), pre-rendered at lane init (`prefixCards`) so the
 *      rendered prefix is byte-identical across turns. Finder candidates
 *      render as compact snippet lines: the matched section's text (or the
 *      curated `links` description for an edge hit), falling back to the
 *      page's lead-section text when no match text exists.
 *
 *      The finder tail is NOT deduped against the stable prefix: a finder hit
 *      on a core/hot page keeps its matched-section line (and its
 *      `matchedSections` ref + `lanes.finder` entry), so the selector and the
 *      section spotlight see that page's CURRENT relevance even though the
 *      page itself sits in the stable prefix. The selector dedupes selections
 *      by slug.
 *   3. A SINGLE forced-tool select (`selectPool`) over the whole pool. The
 *      result is this turn's selections — current turn only. Cross-turn
 *      persistence is the injector's job (net-new blocks frozen into history),
 *      not a per-turn re-rendered carry set.
 */

import type { AssistantConfig } from "../../../../config/schema.js";
import { getLogger } from "../../../../util/logger.js";
import { denseLaneScored } from "./dense.js";
import type { EdgeGraph } from "./edge.js";
import { edgeExpand } from "./edge.js";
import type { EntityIndex } from "./entity-lane.js";
import { entityLane } from "./entity-lane.js";
import { checkV3Gate, type V3GateConfig, type V3GateResult } from "./gate.js";
import type { PoolCandidate, StableCandidate } from "./pool-select.js";
import { selectAllPoolCandidates, selectPool } from "./pool-select.js";
import type { SectionNeedle } from "./section-needle.js";
import type {
  FinderLane,
  MemoryRoutingTurn,
  Section,
  SectionIndex,
  SelectedPage,
  Slug,
} from "./types.js";

// Named to disambiguate from the unrelated `src/config/memory-v3-gate.ts`: this
// logger names the per-turn INJECTION gate wired in below.
const log = getLogger("memory-v3-injection-gate");

/** Default number of BM25 needle articles to fold into the pool. */
export const DEFAULT_NEEDLE_K = 12;
/** Default number of dense-lane articles to fold into the pool. */
export const DEFAULT_DENSE_K = 0;
/** Default hard cap on entity-lane articles folded into the pool per turn. */
export const DEFAULT_ENTITY_CAP = 8;

export interface OrchestrateDeps {
  sectionIndex: SectionIndex;
  needle: SectionNeedle;
  /** Heading-anchored entity catalog (distinctive `## ` heading tokens → their
   *  sections), built at lane init when the entity lane is enabled. Omitted
   *  disables the lane. */
  entityIndex?: EntityIndex;
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
  /** The modification-recency fresh set in recency order (computed at lane
   *  init with core and hot excluded). Follows hot in the stable prefix. */
  freshSlugs: Slug[];
  /** Skills pinned into the candidate pool every turn regardless of retrieval
   *  (existence-filtered and core/hot/fresh-excluded at lane init). Follow fresh
   *  in the stable prefix so the selector always sees them. */
  alwaysCandidateSlugs?: Slug[];
  /** Pre-rendered FULL cards for the stable-prefix slugs, keyed by slug.
   *  Rendered ONCE at lane init so the selector's stable prefix is
   *  byte-identical across turns (the cache contract). Every core/hot/fresh
   *  slug MUST have an entry — a missing card is a lane-init bug and throws
   *  (silently degrading would violate the byte-stable-prefix contract). */
  prefixCards: ReadonlyMap<Slug, string>;
  /** Number of BM25 needle articles. Defaults to {@link DEFAULT_NEEDLE_K}. */
  needleK?: number;
  /** Number of dense-lane articles. Defaults to {@link DEFAULT_DENSE_K}. */
  denseK?: number;
  /** Hard cap on entity-lane articles. Defaults to {@link DEFAULT_ENTITY_CAP}.
   *  Ignored when `entityIndex` is omitted (the lane is off). */
  entityCap?: number;
  /** Per-lane article budget for the reply-query pass (needle + dense re-run
   *  over `turn.previousAssistantMessage` as separate queries). `0` or
   *  omitted disables the pass (canonical value: `memory.v3.replyQueryK`). */
  replyQueryK?: number;
  /** Number of top needle+dense seeds expanded. When omitted, the edge lane's
   *  own default applies (canonical value: `memory.v3.edge.seedCount`). */
  edgeSeeds?: number;
  /** Neighbours surfaced per expanded edge seed. When omitted, the edge lane's
   *  own default applies (canonical value: `memory.v3.edge.perSeed`). */
  edgePerSeed?: number;
  /** Hard cap on total edge-lane surfaced articles. When omitted, the edge
   *  lane's own default applies (canonical value: `memory.v3.edge.cap`). */
  edgeCap?: number;
  /** The learned-edge graph (co-selection NPMI associations, built at lane
   *  init). Omitted or empty → no learned pass. */
  learnedGraph?: EdgeGraph;
  /** Learned neighbours surfaced per expanded seed (canonical value:
   *  `memory.v3.learnedEdges.perSeed`). */
  learnedPerSeed?: number;
  /** Hard cap on total learned-lane surfaced articles; `0` disables the pass
   *  (canonical value: `memory.v3.learnedEdges.cap`). */
  learnedCap?: number;
  /** The selector's system prompt. Omitted → the selector's bundled default.
   *  The live caller resolves `memory.v3.selectorPromptPath` (workspace-relative
   *  file override) via `resolveSelectorPrompt` and threads the result here. */
  selectorPrompt?: string;
  /** Whether to run the selector LLM. False passes all pooled candidates
   *  straight through as selections, preserving pool-order slug dedup. */
  selectorEnabled?: boolean;
  /** Per-turn injection gate config (`memory.v3.gate` tuning + the flag-derived
   *  `enabled`, assembled in observeTurn). Omitted/disabled → the gate never
   *  runs and every turn proceeds to selectPool as before. */
  gateConfig?: V3GateConfig;
}

/** A finder-lane candidate: the slug, the descriptor that justified it, and
 *  the finder lane that FIRST surfaced it (needle → dense → edge precedence). */
export interface FinderCandidate {
  slug: Slug;
  descriptor: string;
  lane: FinderLane;
}

/**
 * The candidate lanes in cache order. `core`, `hot`, and `fresh` are the
 * stable prefix (byte-identical across turns while lanes are unchanged);
 * `finder` is the dynamic tail and MAY repeat a stable-prefix slug (a finder
 * hit on a stable-prefix page is kept so its current relevance stays visible
 * downstream).
 */
export interface OrchestrateLanes {
  /** Curated core set, file order. */
  core: Slug[];
  /** Frecency hot set, score order (never overlaps core). */
  hot: Slug[];
  /** Modification-recency fresh set, recency order (never overlaps core/hot). */
  fresh: Slug[];
  /** Finder candidates in surfacing order, deduped among themselves only. */
  finder: FinderCandidate[];
}

export interface OrchestrateResult {
  /** This turn's selections, deduped by slug (pinned flags ORed; the dedup is
   *  `selectPool`'s contract). Current turn only — there is no
   *  carried-forward set unioned in. */
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

  // The stable prefix: core (file order), hot (score order), fresh (recency
  // order), then always-candidate skills. Hot is computed with core excluded at
  // lane init, fresh with both excluded, always-candidate with all three
  // excluded; the filters here are a cheap defensive dedup so a misbehaving lane
  // can never double-list a slug.
  const core = deps.coreSlugs;
  const hot = deps.hotSlugs.filter((slug) => !core.includes(slug));
  const coreHot = new Set<Slug>([...core, ...hot]);
  const fresh = deps.freshSlugs.filter((slug) => !coreHot.has(slug));
  const coreHotFresh = new Set<Slug>([...coreHot, ...fresh]);
  const always = (deps.alwaysCandidateSlugs ?? []).filter(
    (slug) => !coreHotFresh.has(slug),
  );
  const stablePrefix = new Set<Slug>([...coreHotFresh, ...always]);

  // The stable prefix as FULL CARDS, in cache order. Pre-rendered at lane init
  // (`prefixCards`) so the rendered prefix is byte-identical across turns. A
  // missing card is a lane-init bug and throws (silently degrading would violate
  // the byte-stable-prefix contract). Built lazily so the gate's bypass path can
  // reuse the exact same construction as the normal step-2 pool assembly.
  const buildStable = (): StableCandidate[] =>
    [...core, ...hot, ...fresh, ...always].map((slug) => {
      const card = deps.prefixCards.get(slug);
      if (card === undefined) {
        // Lane init renders a card for every core/hot slug; a hole here means
        // the lanes and the card map are out of sync. Throw rather than render
        // a degraded card — the caller (observeTurn) logs and skips the turn,
        // which is better than silently breaking the byte-stable prefix.
        throw new Error(
          `memory-v3: no pre-rendered card for stable-prefix slug "${slug}"`,
        );
      }
      return { slug, card };
    });

  // Step 1: needle (sync BM25) and the enabled dense lane (async embed +
  // Qdrant) run in parallel. Both return distinct articles each tagged with
  // their best-scoring section index/ordinal. The reply-query pass re-runs the
  // enabled lanes over the assistant's previous message as SEPARATE queries
  // (concatenating the two speakers would average their retrieval intents into
  // a vector that matches neither) at its own, smaller budget; it runs in the
  // same parallel batch.
  // `denseK = 0` disables dense retrieval for the whole turn, including the
  // reply-query dense pass.
  const replyK = deps.replyQueryK ?? 0;
  const replyQuery =
    replyK > 0 ? (turn.previousAssistantMessage ?? "").trim() : "";
  const denseEnabled = denseK > 0;
  const [needled, densed, replyNeedled, replyDensed] = await Promise.all([
    Promise.resolve(deps.needle.queryScored(turn.currentMessage, needleK)),
    denseEnabled
      ? denseLaneScored(deps.denseConfig, turn.currentMessage, denseK)
      : Promise.resolve([]),
    Promise.resolve(
      replyQuery.length > 0 ? deps.needle.queryScored(replyQuery, replyK) : [],
    ),
    replyQuery.length > 0 && denseEnabled
      ? denseLaneScored(deps.denseConfig, replyQuery, replyK)
      : Promise.resolve([]),
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

  // Step 1b': reply-query hits — candidates the user-message lanes already
  // surfaced keep their primary attribution (`addFinder`'s first-lane-wins
  // dedup); only genuinely reply-surfaced articles tag `"reply"`. Matched
  // sections are recorded the same way as the primary lanes', so injection
  // and the spotlight render the reply-matched section.
  for (const hit of replyNeedled) {
    addFinder(hit.article, sections[hit.section], undefined, "reply");
  }
  for (const hit of replyDensed) {
    if (!deps.sectionIndex.byArticle.has(hit.article)) continue;
    addFinder(
      hit.article,
      sectionByOrdinal(deps.sectionIndex, hit.article, hit.section),
      undefined,
      "reply",
    );
  }

  // Step 1b'': entity lane — sections whose `## ` heading NAMES a distinctive
  // entity the message mentions. Additive BM25 buries a single named entity
  // under a long, multi-topic message's bulk theme; this keys on the heading
  // vocabulary so the page the user named surfaces regardless of the bulk
  // theme. Runs before edge expansion so an entity hit joins `finderSeen` (edge
  // won't re-surface it section-less); it is NOT added to the edge seeds, so it
  // only contributes its own page.
  //
  // The heading section IS the identity this lane exists to surface, so it
  // takes precedence over any bulk-theme section a prior lane (needle / dense /
  // reply) already recorded for the SAME page: `addFinder` keeps the first
  // matched section and skips duplicate slugs, so override the matched section
  // and the existing finder descriptor here before delegating, ensuring
  // injection, the spotlight, and the selector snippet all render the heading
  // rather than the earlier non-entity match.
  if (deps.entityIndex) {
    for (const hit of entityLane(
      deps.entityIndex,
      deps.sectionIndex,
      turn.currentMessage,
      deps.entityCap ?? DEFAULT_ENTITY_CAP,
    )) {
      const section = sections[hit.section];
      if (section) {
        matchedSections.set(hit.article, section);
        const existing = finder.find((c) => c.slug === hit.article);
        if (existing) existing.descriptor = section.text;
      }
      addFinder(hit.article, section, undefined, "entity");
    }
  }

  // Step 1b''': opt-in injection gate. With the CURRENT-message finder lanes in
  // hand (needle + dense — NOT reply/entity/edge, which only add recall), decide
  // whether retrieval is confident enough to spend the selectPool LLM call this
  // turn. Default-off via `?.enabled`; pass-open on any throw (a gate bug must
  // never drop a turn's memory). A closed gate either hard-skips selection
  // (empty selections) or, when `bypassForCore` is set, runs selectPool over the
  // stable prefix only — never the finder tail.
  if (deps.gateConfig?.enabled) {
    let gate: V3GateResult | null = null;
    try {
      gate = checkV3Gate({
        needleHits: needled,
        denseHits: densed,
        config: deps.gateConfig,
      });
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: turn.conversationId,
        },
        "memory-v3 injection gate threw; passing open (proceeding with selection)",
      );
    }
    if (gate) {
      log.info(
        {
          conversationId: turn.conversationId,
          turnNumber: turn.turnNumber,
          reason: gate.reason,
          pass: gate.pass,
          topDenseScore: gate.topDenseScore,
          topNormSparseScore: gate.topNormSparseScore,
        },
        "memory-v3 injection gate decision",
      );
      if (!gate.pass) {
        // A closed gate produces no finder lane and no matched sections; only
        // the `selections` differ between bypass (stable prefix) and hard-skip.
        const closed = (selections: SelectedPage[]): OrchestrateResult => ({
          selections,
          matchedSections: new Map(),
          lanes: { core, hot, fresh, finder: [] },
        });
        return deps.gateConfig.bypassForCore
          ? closed(
              await selectPool(
                { stable: buildStable(), finder: [] },
                turn,
                deps.selectorPrompt,
              ),
            )
          : closed([]);
      }
    }
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

  // Step 1d: learned-edge expansion over the SAME seeds, through the
  // co-selection NPMI graph. Mirrors the static edge pass — no matched
  // section (association, not lexical relevance, surfaced the page; injection
  // falls back to the full page), `bestSection` text as the descriptor
  // fallback — but tags `"learned"` so the lane's selection rate is
  // measurable. Runs after the static lane: an association that duplicates an
  // authored link keeps its `"edge"` attribution.
  if (deps.learnedGraph && (deps.learnedCap ?? 0) > 0) {
    const learned = edgeExpand(deps.learnedGraph, seeds, {
      seedCount: deps.edgeSeeds,
      perSeed: deps.learnedPerSeed,
      cap: deps.learnedCap,
      alive: (slug) => !finderSeen.has(slug) && !stablePrefix.has(slug),
    });
    for (const neighbor of learned) {
      const best = deps.needle.bestSection(
        neighbor.article,
        turn.currentMessage,
      );
      addFinder(
        neighbor.article,
        undefined,
        best >= 0 ? sections[best]?.text : undefined,
        "learned",
      );
    }
  }

  // Step 2: assemble the selector pool in cache order — the stable prefix
  // (core, hot, fresh) as FULL CARDS, then the finder tail. Cards are
  // pre-rendered at lane init (`prefixCards`): query- AND
  // conversation-state-INDEPENDENT by design, so the rendered prefix is
  // byte-identical across turns while the lanes are unchanged. The tail is
  // NOT deduped against the prefix — a finder hit on a core/hot page renders
  // its own snippet line so its CURRENT relevance stays visible; `selectPool`
  // dedupes selections by slug. Finder candidates with no match text fall
  // back to the page's lead-section snippet.
  const stable = buildStable();
  const finderTail: PoolCandidate[] = finder.map((c) => ({
    slug: c.slug,
    lane: c.lane,
    descriptor:
      c.descriptor.trim().length > 0
        ? c.descriptor
        : leadSectionText(deps.sectionIndex, c.slug),
  }));

  // Step 3: a SINGLE forced-tool select over the cache-ordered pool. The
  // selections come back slug-deduped (pinned flags ORed) — `selectPool`'s
  // contract. `selectorPrompt` is the (optionally overridden) instruction
  // scaffold; `undefined` falls through to the bundled default.
  const pool = { stable, finder: finderTail };
  const selections =
    deps.selectorEnabled === false
      ? selectAllPoolCandidates(pool)
      : await selectPool(pool, turn, deps.selectorPrompt);

  return {
    selections,
    matchedSections,
    lanes: { core, hot, fresh, finder },
  };
}

/**
 * Resolve a dense-lane hit's matched ordinal to the concrete `Section` in the
 * in-memory index. The dense store keys sections by `(article, ordinal)`, so we
 * scan the article's sections for the matching ordinal. Returns `undefined`
 * when the article or ordinal is not in the index (e.g. the dense store is
 * ahead of the in-memory rebuild).
 */
export function sectionByOrdinal(
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
 * no indexed sections. Used as the finder-line snippet fallback when a
 * candidate carries no match text (e.g. an edge hit with neither a curated
 * description nor a scoring section) — the lead is the closest free
 * approximation of the card head.
 */
function leadSectionText(index: SectionIndex, article: Slug): string {
  const first = index.byArticle.get(article)?.[0];
  return first === undefined ? "" : (index.sections[first]?.text ?? "");
}
