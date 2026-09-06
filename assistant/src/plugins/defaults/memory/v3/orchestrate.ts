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
 *          naming —
 *        - the span-query pass — the dense lane re-run over the current
 *          message's clause chunks as separate queries at a small per-chunk
 *          budget (`spanQueryK`), rescuing motifs a long multi-topic message's
 *          single query vector averages away,
 *        - the entity lane (`entityLane`) and the rare-term lane
 *          (`rareTermLane`), which key on one strong token each (a
 *          distinctive `## ` heading token the message names; a query word
 *          that occurs in at most a handful of sections) so the section a
 *          name or a rare word points at surfaces regardless of the
 *          message's bulk theme, and
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
 *      `bypassForCore` is set, selecting over the stable prefix only via the
 *      same selector dispatch as the normal path, honoring `selectorEnabled`) —
 *      so a low-signal turn pays no selector cost. The gate is pass-open: any
 *      throw inside it logs a warning and falls through to normal selection.
 *   2. Build the candidate pool in CACHE ORDER: the stable prefix —
 *      `[...core (file order), ...hot (score order), ...fresh (recency order),
 *      ...always-candidate (skills listed every turn)]`, all computed at lane
 *      init, followed by the finder candidates (needle → dense → reply →
 *      span → entity → rare → edge → learned surfacing order), one line per
 *      distinct (page, matched section) and at most `finderSectionsPerPage`
 *      lines per page from the lanes other than entity and rare (an entity
 *      line and a rare-term line never count against the cap or yield to it;
 *      see `poolLine`), so a page whose sections match different parts of
 *      the message is shown section by section. The stable prefix
 *      is identical across consecutive turns while the lanes are unchanged
 *      (lane invalidation at consolidation is the recompute cadence), so the
 *      selector input's leading segment rides the provider KV cache (the
 *      cache breakpoint itself lives in `pool-select.ts`).
 *
 *      Stable-prefix candidates render as FULL CARDS (`renderCard` — head
 *      section + TOC), pre-rendered at lane init (`prefixCards`) so the
 *      rendered prefix is byte-identical across turns. Finder candidates
 *      render as compact snippet lines: the matched section's
 *      keyword-in-context window around the query terms that scored it (or
 *      the curated `links` description for an edge hit), falling back to
 *      the page's lead-section text when no match text exists.
 *
 *      The finder tail is NOT deduped against the stable prefix: a finder hit
 *      on a core/hot page keeps its matched-section line (and its
 *      `lanes.finder` entry), so the selector and the
 *      section injection see that page's CURRENT relevance even though the
 *      page itself sits in the stable prefix. The selector merges selections
 *      per slug, carrying every selected section.
 *   3. A SINGLE forced-tool select (`selectPool`) over the whole pool. The
 *      result is this turn's selections — current turn only. Cross-turn
 *      persistence is the injector's job (net-new blocks frozen into history),
 *      not a per-turn re-rendered carry set.
 */

import type { AssistantConfig } from "../../../../config/schema.js";
import {
  recordLatencySubSpan,
  timeLatencySubSpan,
} from "../../../../daemon/turn-latency-sub-spans.js";
import { recordWatchdogEvent } from "../../../../telemetry/watchdog-events-store.js";
import { getLogger } from "../logging.js";
import { injectionUnits } from "./capabilities.js";
import { denseLaneScored } from "./dense.js";
import type { EdgeGraph } from "./edge.js";
import { edgeExpand } from "./edge.js";
import type { EntityIndex } from "./entity-lane.js";
import { entityLane } from "./entity-lane.js";
import { checkV3Gate, type V3GateConfig, type V3GateResult } from "./gate.js";
import type {
  PoolCandidate,
  SelectorPool,
  StableCandidate,
} from "./pool-select.js";
import { selectAllPoolCandidates, selectPool } from "./pool-select.js";
import {
  type RareTermHit,
  rareTermLane,
  type RareTermLaneOptions,
} from "./rare-term-lane.js";
import type { SectionNeedle } from "./section-needle.js";
import { spanChunksOf } from "./span-query.js";
import {
  type FinderLane,
  type MemoryRoutingTurn,
  type Section,
  type SectionIndex,
  sectionKey,
  type SelectedPage,
  type Slug,
} from "./types.js";

// Named to disambiguate from the unrelated `src/config/memory-v3-gate.ts`: this
// logger names the per-turn INJECTION gate wired in below.
const log = getLogger("memory-v3-injection-gate");

/** `check_name` of the `watchdog` telemetry event recorded once per
 *  injection-gate run. The platform's memory admin analytics count and filter
 *  on this exact string — keep it stable. */
export const MEMORY_V3_INJECTION_GATE_CHECK_NAME = "memory_v3_injection_gate";

/** Record one injection-gate run to usage telemetry. `detail` keys are the
 *  platform-side contract (snake_case; scores, reason codes, and corpus-size
 *  counts only — never page titles, slugs, or conversation content). Never
 *  throws: the gate is pass-open by design, and a telemetry failure must not
 *  cost the turn its memory either.
 *
 *  `detail.scored` says whether checkV3Gate actually weighed scores this run, as
 *  opposed to the run taking a pass-open shortcut (dense off, dense unavailable,
 *  gate threw). Pass rate is only meaningful over scored runs — the shortcuts are
 *  all unconditional passes and would otherwise inflate it. It is derivable from
 *  `reason`, but the daemon owns the reason set and adds to it freely, so it is
 *  reported explicitly rather than left for the platform to re-derive from a
 *  hardcoded list that would silently miscount the next reason we add. */
function recordGateRun(detail: Record<string, unknown>): void {
  try {
    recordWatchdogEvent({
      checkName: MEMORY_V3_INJECTION_GATE_CHECK_NAME,
      value: 1,
      detail,
    });
  } catch {
    // recordWatchdogEvent already no-ops on opt-out and a missing telemetry
    // DB; anything past that is not worth failing the turn over.
  }
}

/** `check_name` of the `watchdog` telemetry event recorded once per orchestrated
 *  turn, carrying what the SELECTOR did. Keep this string stable — the platform's
 *  memory admin analytics filter on it. */
export const MEMORY_V3_SELECTION_CHECK_NAME = "memory_v3_selection";

/** Record one turn's selection outcome. Deliberately a SEPARATE event from
 *  {@link MEMORY_V3_INJECTION_GATE_CHECK_NAME} rather than extra keys on it: the
 *  gate records at decision time, before selection has run, so folding the
 *  outcome in would mean deferring the gate event until after `selectPool` — and
 *  losing every gate run whenever selection throws, which is exactly the
 *  incident we would want the gate telemetry for. This event carries
 *  `gate_reason` so the two still group together without a join.
 *
 *  `value` is the selection count. Never throws, same as the gate counter. */
function recordSelectionRun(
  value: number,
  detail: Record<string, unknown>,
): void {
  try {
    recordWatchdogEvent({
      checkName: MEMORY_V3_SELECTION_CHECK_NAME,
      value,
      detail,
    });
  } catch {
    // Same contract as recordGateRun: telemetry must never cost a turn.
  }
}

/** Default number of BM25 needle articles to fold into the pool. */
export const DEFAULT_NEEDLE_K = 12;
/** Default number of dense-lane articles to fold into the pool. */
export const DEFAULT_DENSE_K = 0;
/** Default hard cap on entity-lane articles folded into the pool per turn. */
export const DEFAULT_ENTITY_CAP = 8;
/** Contributing query terms carried per finder candidate for its
 *  keyword-in-context snippet (the renderer uses the first one that occurs
 *  in the section body). */
const SNIPPET_TERMS = 3;

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
  /** Skills placed in the candidate pool every turn regardless of retrieval
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
  /** Rare-term lane tuning (canonical value: `memory.v3.rareTerm`): the df
   *  ceiling for a query word to count as rare (`maxDf`, lowered on a smaller
   *  corpus by `maxDfFraction`), the sections surfaced per rare word, and the
   *  per-turn cap. Omitted disables the lane, which the caller does whenever
   *  the selector is off: rare lines are candidates for a judge, not evidence
   *  strong enough to inject unjudged. */
  rareTerm?: RareTermLaneOptions;
  /** Cap on finder lines one page may carry per turn, applied in surfacing
   *  order (needle, dense, reply, span); a section-less edge or learned line
   *  counts as one. An entity line and a rare-term line are outside the cap,
   *  neither counted against it nor displaced by it (the lanes' own
   *  `entityCap` and `rareTerm.cap` bound those per turn), so a page carries
   *  at most this many lines plus its entity and rare lines (canonical
   *  value, default included: `memory.v3.finderSectionsPerPage`). */
  finderSectionsPerPage: number;
  /** Per-lane article budget for the reply-query pass (needle + dense re-run
   *  over `turn.previousAssistantMessage` as separate queries). `0` or
   *  omitted disables the pass (canonical value: `memory.v3.replyQueryK`). */
  replyQueryK?: number;
  /** Per-chunk article budget for the span-query pass (dense re-run over the
   *  current message's clause chunks as separate queries). `0` or omitted
   *  disables the pass; it is also inert when the dense lane is disabled or
   *  the message yields fewer than two chunks (canonical value:
   *  `memory.v3.spanQueryK`). */
  spanQueryK?: number;
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
  /** Per-turn injection gate config (the `memory.v3.gate` tuning, threaded
   *  through by observeTurn). Omitted/disabled → the gate never runs and every
   *  turn proceeds to selectPool as before. */
  gateConfig?: V3GateConfig;
  /** Real concept-page count at lane build — the same corpus-size signal
   *  `resolveV3Tuning` switches the lean/full profile on. Reported with each
   *  gate run so the reason distribution can be read against
   *  `MEMORY_V3_FULL_PROFILE_MIN_PAGES`; omitted drops the field from the
   *  telemetry detail (the gate itself never reads it). */
  realConceptPageCount?: number;
  /** Whether one of this turn's injection units (`injectionUnits` in
   *  `capabilities.ts`: a selected section, or the lead of a page selected
   *  with none, by page slug and section-store key) is already resident in
   *  the conversation. Used ONLY to compute the `net_new_count` telemetry
   *  field, selections it rejects are what the injector actually renders.
   *  Read-only and side-effect-free: selection never consults it, and
   *  omitting it just drops the field. The injector reads the same store, so
   *  the two agree for a turn that has not yet committed. */
  isResident?: (slug: Slug, key: string) => boolean;
}

/** A finder-lane candidate, one pool line: the slug, the matched section
 *  when the lane scored one (absent for an edge or learned hit), the query
 *  terms that contributed most to that match (best first; they drive the
 *  selector's keyword-in-context snippet, and a rare-term line carries the
 *  one word it was keyed on as its only term), the descriptor that
 *  justified the line, and the lane that surfaced it. One page can carry
 *  several candidates, one per distinct matched section, in surfacing
 *  order. */
export interface FinderCandidate {
  slug: Slug;
  section?: Section;
  terms?: string[];
  descriptor: string;
  lane: FinderLane;
}

/**
 * The candidate lanes in cache order. `core`, `hot`, `fresh`, and `always` are
 * the stable prefix (byte-identical across turns while lanes are unchanged);
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
  /** Always-candidate skills, install order (never overlaps core/hot/fresh). */
  always: Slug[];
  /** Finder candidates in surfacing order: one per distinct (page, matched
   *  section), capped per page, deduped among themselves only. */
  finder: FinderCandidate[];
}

export interface OrchestrateResult {
  /** This turn's selections, one per slug with the selected finder lines'
   *  sections merged in pool order (the merge is `selectPool`'s contract);
   *  the injector renders each of them. Current turn only: there is no
   *  carried-forward set unioned in. */
  selections: SelectedPage[];
  /** The candidate lanes in cache order; see {@link OrchestrateLanes}. Consumed
   *  by the selection telemetry (lane attribution), the per-turn pool record
   *  (`pool-log-store.ts`), and the downstream selector rendering. */
  lanes: OrchestrateLanes;
  /** Whether the selector LLM judged a non-empty pool this turn (the
   *  `selector_ran` telemetry field). False when the pool was empty, when the
   *  disabled-selector passthrough kept every candidate, and when a closed
   *  injection gate hard-skipped selection. On that last path `lanes` still
   *  carries the stable prefix as computed, but no pool was ever assembled,
   *  so a false value with empty `selections` means the selector was given
   *  nothing. */
  selectorRan: boolean;
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

  // Run the selector over a pool, or pass its candidates straight through when
  // the selector LLM is disabled (`selectorEnabled: false`, the new-user
  // profile). Shared by the normal step-3 selection and the gate's
  // bypass-to-stable path so the two cannot diverge. `keptAll` marks the
  // selector's recall-safe fallback ONLY — the disabled passthrough is not a
  // selector judgment, so it reports `false` (its turns are excluded from any
  // relevance read by `selector_ran` anyway).
  const runSelection = (
    pool: SelectorPool,
  ): Promise<{ selections: SelectedPage[]; keptAll: boolean }> =>
    timeLatencySubSpan("v3_selection", "Memory selection", async () => {
      if (deps.selectorEnabled === false) {
        return { selections: selectAllPoolCandidates(pool), keptAll: false };
      }
      const { pages, keptAll } = await selectPool(
        pool,
        turn,
        deps.selectorPrompt,
      );
      return { selections: pages, keptAll };
    });

  // Step 1: needle (sync BM25) and the enabled dense lane (async embed +
  // Qdrant) run in parallel. Both return distinct articles each tagged with
  // their best-scoring section index/ordinal. The reply-query pass re-runs the
  // enabled lanes over the assistant's previous message as SEPARATE queries
  // (concatenating the two speakers would average their retrieval intents into
  // a vector that matches neither) at its own, smaller budget; it runs in the
  // same parallel batch.
  // `denseK = 0` disables dense retrieval for the whole turn, including the
  // reply-query and span-query dense passes.
  const replyK = deps.replyQueryK ?? 0;
  const replyQuery =
    replyK > 0 ? (turn.previousAssistantMessage ?? "").trim() : "";
  const denseEnabled = denseK > 0;
  // The span-query pass re-runs the dense lane over the current message's
  // clause chunks as SEPARATE queries (a single embedding of a multi-topic
  // message averages its intents into a vector that matches none of them —
  // the within-message form of the averaging the reply pass avoids across
  // speakers). A single-chunk message would just duplicate the full-message
  // dense query, so the pass needs at least two chunks to run.
  const spanK = deps.spanQueryK ?? 0;
  const spanChunks =
    spanK > 0 && denseEnabled ? spanChunksOf(turn.currentMessage) : [];
  const spanQueries = spanChunks.length >= 2 ? spanChunks : [];
  const [needled, densed, replyNeedled, replyDensed, spanDensed] =
    await timeLatencySubSpan("v3_lanes", "Memory search", () =>
      Promise.all([
        Promise.resolve(deps.needle.queryScored(turn.currentMessage, needleK)),
        denseEnabled
          ? denseLaneScored(deps.denseConfig, turn.currentMessage, denseK)
          : Promise.resolve([]),
        Promise.resolve(
          replyQuery.length > 0
            ? deps.needle.queryScored(replyQuery, replyK)
            : [],
        ),
        replyQuery.length > 0 && denseEnabled
          ? denseLaneScored(deps.denseConfig, replyQuery, replyK)
          : Promise.resolve([]),
        Promise.all(
          spanQueries.map((chunk) =>
            denseLaneScored(deps.denseConfig, chunk, spanK),
          ),
        ),
      ]),
    );
  // Everything from here to the step-3 selection (finder assembly, the
  // entity and rare-term lanes, the injection gate, edge + learned-edge
  // expansion, pool assembly) is synchronous in-memory work, measured as one
  // `v3_expand` region rather than wrapped calls. Gate-closed early returns
  // skip the record on purpose: the expansion work didn't happen on those
  // turns.
  const expandStartedAt = Date.now();

  // Dense hits restricted to pages still in the live section index. A deleted
  // page's points can linger in Qdrant; the candidate pool already drops those
  // (see the dense finder loop), so the gate must score the same live set —
  // stale low-scored hits for deleted pages must neither fake dense availability
  // nor drag the gate closed while the live lanes have candidates.
  const liveDensed = densed.filter((hit) =>
    deps.sectionIndex.byArticle.has(hit.article),
  );

  // `finder` accumulates the pool's dynamic tail: one entry per distinct
  // (article, matched section), in the needle → dense → reply → span →
  // entity → rare call order, so a page whose sections match different parts of
  // the message carries one line per section and the selector sees each
  // section's own text. A hit that resolves to no section (an edge or
  // learned neighbour, a dense ordinal the index no longer holds) is one
  // section-less line per page, added only when nothing has surfaced the
  // page yet. Each page's lines are capped at `finderSectionsPerPage` in
  // surfacing order, its entity and rare lines aside (`poolLine`). Hits on
  // stable-prefix slugs are kept like any other, so the selector and the
  // injection see those pages' CURRENT relevance.
  const finderCap = deps.finderSectionsPerPage;
  const finder: FinderCandidate[] = [];
  const finderByArticle = new Map<Slug, FinderCandidate[]>();

  // Whether a line counts against its page's cap. An entity line and a
  // rare-term line do not: both lanes key on one strong token the message
  // names and run after every lane that fills the cap, so holding them to
  // the cap would displace exactly the line each lane exists to surface.
  // The lanes' own caps (`entityCap`, `rareTerm.cap`) bound the lines they
  // add per turn instead.
  const countsAgainstCap = (line: FinderCandidate): boolean =>
    line.lane !== "entity" && line.lane !== "rare";

  // Pool a line for its page unless the page already carries it or is at
  // the cap: a line with a section duplicates a line for the same section
  // key; a section-less line duplicates any line. The cap holds the page's
  // counted lines at `finderCap`; a line outside the cap joins past it, so a
  // page carries at most `finderCap` counted lines plus its entity and rare
  // lines, `finderCap + entityCap + rareTerm.cap` in all.
  const poolLine = (candidate: FinderCandidate): void => {
    const lines = finderByArticle.get(candidate.slug) ?? [];
    const key = candidate.section ? sectionKey(candidate.section) : undefined;
    const duplicate =
      key === undefined
        ? lines.length > 0
        : lines.some((c) => c.section && sectionKey(c.section) === key);
    const atCap =
      countsAgainstCap(candidate) &&
      lines.filter(countsAgainstCap).length >= finderCap;
    if (duplicate || atCap) {
      return;
    }
    lines.push(candidate);
    finderByArticle.set(candidate.slug, lines);
    finder.push(candidate);
  };

  // A lane hit on section `doc` (an index into `sections`) scored against
  // `query`, whose best-contributing terms ride the line for the selector's
  // keyword-in-context snippet. A `doc` the index does not hold pools as a
  // section-less line with a blank descriptor.
  const addSectionHit = (
    slug: Slug,
    doc: number | undefined,
    lane: FinderLane,
    query: string,
  ): void => {
    const section = doc === undefined ? undefined : sections[doc];
    poolLine(
      doc !== undefined && section
        ? {
            slug,
            section,
            terms: deps.needle.topTerms(doc, query, SNIPPET_TERMS),
            descriptor: section.text,
            lane,
          }
        : { slug, descriptor: "", lane },
    );
  };

  // A rare-term hit is keyed on one query word, which is the line's only
  // snippet term and, through the lane, its tag.
  const addRareHit = (hit: RareTermHit): void => {
    const section = sections[hit.section]!;
    poolLine({
      slug: hit.article,
      section,
      terms: [hit.term],
      descriptor: section.text,
      lane: "rare",
    });
  };

  // A page surfaced by association (an edge or learned neighbour): no
  // section, described by its curated `links` text or a fallback.
  const addNeighbour = (
    slug: Slug,
    descriptor: string | undefined,
    lane: FinderLane,
  ): void => {
    poolLine({ slug, descriptor: descriptor ?? "", lane });
  };

  // Step 1a: needle hits, `section` is an index into `sections`.
  for (const hit of needled) {
    addSectionHit(hit.article, hit.section, "needle", turn.currentMessage);
  }

  // Step 1b: dense hits, `section` is the matched ORDINAL; resolve it to the
  // section's index via the section index. An ordinal the in-memory index
  // does not hold yields a section-less candidate (blank descriptor).
  for (const hit of densed) {
    // A deleted page's points can linger in Qdrant; keep only live-index
    // articles. The section index is rebuilt from `getPageIndex` at `initLanes`,
    // so `byArticle` holds exactly the live pages (synthetic capability slugs
    // included), only truly-deleted pages are dropped here.
    if (!deps.sectionIndex.byArticle.has(hit.article)) {
      continue;
    }
    addSectionHit(
      hit.article,
      sectionDocByOrdinal(deps.sectionIndex, hit.article, hit.section),
      "dense",
      turn.currentMessage,
    );
  }

  // Step 1b': reply-query hits. A section the user-message lanes already
  // pooled is a no-op (`poolLine`'s pair dedup), so only a genuinely
  // reply-surfaced section tags `"reply"`; its snippet terms come from the
  // reply text it was scored against.
  for (const hit of replyNeedled) {
    addSectionHit(hit.article, hit.section, "reply", replyQuery);
  }
  for (const hit of replyDensed) {
    if (!deps.sectionIndex.byArticle.has(hit.article)) {
      continue;
    }
    addSectionHit(
      hit.article,
      sectionDocByOrdinal(deps.sectionIndex, hit.article, hit.section),
      "reply",
      replyQuery,
    );
  }

  // Step 1b'': span-query hits, union-additive at the pass's own small
  // budget. A section a primary or reply lane already pooled is a no-op; a
  // different section of an already-surfaced page joins as its own line,
  // which is the buried-clause match the pass exists to recover. Like the
  // reply pass, span hits are excluded from the injection gate (which scores
  // current-message needle + dense only) and from the edge-expansion seeds.
  //
  // Several chunks can hit one article on different sections; they are
  // pooled strongest cosine first, so chunk order never decides which
  // sections fill the page's cap.
  const spanHits = spanDensed.flat().sort((a, c) => c.score - a.score);
  for (const hit of spanHits) {
    if (!deps.sectionIndex.byArticle.has(hit.article)) {
      continue;
    }
    addSectionHit(
      hit.article,
      sectionDocByOrdinal(deps.sectionIndex, hit.article, hit.section),
      "span",
      turn.currentMessage,
    );
  }

  // Step 1b''': entity lane, sections whose `## ` heading NAMES a distinctive
  // entity the message mentions. Additive BM25 buries a single named entity
  // under a long, multi-topic message's bulk theme; this keys on the heading
  // vocabulary so the section the user named surfaces regardless of the bulk
  // theme, as its own line beside any bulk-theme section a prior lane pooled
  // for the same page (a no-op when that lane already pooled the heading).
  // Runs before edge expansion so an entity hit counts as surfaced (edge
  // won't re-surface its page section-less); it is NOT added to the edge
  // seeds, so it only contributes its own section.
  if (deps.entityIndex) {
    for (const hit of entityLane(
      deps.entityIndex,
      deps.sectionIndex,
      turn.currentMessage,
      deps.entityCap ?? DEFAULT_ENTITY_CAP,
    )) {
      addSectionHit(hit.article, hit.section, "entity", turn.currentMessage);
    }
  }

  // Step 1b'''': rare-term lane, the sections a rare query word occurs in. A
  // word found in at most `maxDf` sections is a near-certain signal on its
  // own: additive BM25 lets the message's bulk theme pick a page's section,
  // and a query on the clause alone cannot rank a page whose only
  // distinctive token is that word. Each rare word's top sections by
  // single-term score join as their own lines, tagged with the word, which
  // also centers the selector's snippet; a section a prior lane pooled is a
  // no-op, and a page the prior lanes filled to the per-page cap still
  // takes its rare lines (`poolLine`). Like the entity lane, rare hits feed
  // neither the gate nor the edge seeds.
  if (deps.rareTerm) {
    for (const hit of rareTermLane(
      deps.needle,
      deps.sectionIndex,
      turn.currentMessage,
      deps.rareTerm,
    )) {
      addRareHit(hit);
    }
  }

  // Step 1b''''': opt-in injection gate. With the CURRENT-message finder lanes
  // in hand (needle + dense, NOT reply/span/entity/rare/edge, which only add
  // recall), decide whether retrieval is confident enough to spend the
  // selectPool LLM call this turn. Default-off via `?.enabled`; pass-open on
  // any throw (a gate bug must never drop a turn's memory). A closed gate
  // either hard-skips selection (empty selections) or, when `bypassForCore`
  // is set, runs selectPool over the stable prefix only, never the finder
  // tail.
  //
  // The gate is dense-gated: it only runs when the live dense lane produced hits
  // (`liveDensed.length > 0`). In healthy operation dense returns top-k hits for
  // any query, so zero live dense hits means dense is unavailable, NOT low
  // relevance. checkV3Gate reads only finder scores and cannot tell those apart,
  // so without live dense signal we pass open rather than suppress all memory
  // (not even the core/hot/fresh prefix) on every lexically-weak turn.
  //
  // Two very different situations reach that pass-open, and they carry distinct
  // reason codes because only one of them is a problem:
  //   - dense_disabled:    `denseK === 0`, so the lane never ran. The lean
  //                        new-user profile (`MEMORY_V3_NEW_USER_TUNING`) sets it
  //                        for sub-threshold corpora, and that same profile sets
  //                        `selectorEnabled: false` — so there is no selectPool
  //                        call for the gate to save and passing open is free.
  //                        Expected, benign, and the bulk of gate runs.
  //   - dense_unavailable: the lane ran and yielded nothing live — a degraded
  //                        embedding backend, a Qdrant error (`denseLaneScored`
  //                        swallows these to `[]`), or only stale deleted-page
  //                        points. Dense SHOULD have scored this turn and did
  //                        not, so this one is worth alerting on.
  //
  // Every run carries the corpus size, so the reason mix can be read against the
  // profile threshold rather than guessed at: `dense_disabled` is sub-threshold
  // by construction, and whether those assistants sit at 1 page or 9 is the
  // difference between "empty" and "about to cross".
  const recordGate = (detail: Record<string, unknown>): void =>
    recordGateRun(
      deps.realConceptPageCount === undefined
        ? detail
        : { ...detail, real_concept_page_count: deps.realConceptPageCount },
    );

  // This turn's gate decision, carried to the selection event so the two group
  // together without a join. Null when the gate never ran (disabled/omitted).
  let gateOutcome: { reason: string; pass: boolean } | null = null;

  // What the SELECTOR did with the pool the gate let through — the outcome the
  // gate's own pass rate cannot see. A passed gate only means selectPool got to
  // run; the selector is told to return `[]` when no candidate is relevant, so
  // it is the real injection decision and the pass rate is an upper bound on it.
  //
  // `selector_ran` marks the turns where the selector actually JUDGED the pool,
  // and is the filter that keeps a relevance rate honest. Three ways a turn can
  // report zero selections without the selector having been asked, all of which
  // must stay out of that rate:
  //   - the lean profile sets `selectorEnabled: false`, so
  //     `selectAllPoolCandidates` returns the whole pool untouched (would read
  //     as a 100% hit rate),
  //   - a closed gate hard-skips selection entirely (a 0%),
  //   - the pool is empty, and `selectPool` returns `[]` before it ever reaches
  //     the provider (also a 0%).
  // The last is why `poolSize` decides this rather than each call site: an empty
  // pool is not a judgment that nothing was relevant, and no caller has to
  // remember that. `selectorRanOver` is that rule; the selection event and the
  // result's `selectorRan` both read it.
  // `selector_kept_all` and `net_new_count` separate what the selector JUDGED
  // from what actually reaches the turn, which `selected_count` alone conflates:
  //   - kept_all: the recall-safe fallback fired (model omitted `ids`), so every
  //     candidate was kept without a real judgment. Distinguishes "kept the whole
  //     pool because it gave up" from "explicitly selected a large set", which
  //     otherwise look identical and inflate the same way.
  //   - net_new: the injection units among the selections (`injectionUnits`:
  //     each selected section, or the lead of a page selected with none, a
  //     capability page as one unit) not already live in the conversation,
  //     the injector renders only these (prior turns' sections ride
  //     history), so it is the real incremental injection, where
  //     `selected_count` re-counts the whole standing set every turn.
  //     Omitted when the caller did not supply `isResident` (tests,
  //     shadow-less paths). The count reads the same units the injector will
  //     (a closed gate's selections carry no sections, so it counts leads).
  const selectorRanOver = (poolSize: number): boolean =>
    deps.selectorEnabled !== false && poolSize > 0;
  const recordSelection = (
    selections: SelectedPage[],
    poolSize: number,
    keptAll: boolean,
  ): void => {
    const detail: Record<string, unknown> = {
      gate_reason: gateOutcome?.reason ?? null,
      gate_pass: gateOutcome?.pass ?? null,
      selector_ran: selectorRanOver(poolSize),
      selector_kept_all: keptAll,
      selected_count: selections.length,
      pool_size: poolSize,
    };
    const isResident = deps.isResident;
    if (isResident !== undefined) {
      detail.net_new_count = injectionUnits(selections).filter(
        ({ slug, key }) => !isResident(slug, key),
      ).length;
    }
    if (deps.realConceptPageCount !== undefined) {
      detail.real_concept_page_count = deps.realConceptPageCount;
    }
    recordSelectionRun(selections.length, detail);
  };
  if (deps.gateConfig?.enabled) {
    if (liveDensed.length === 0) {
      const reason = denseEnabled ? "dense_unavailable" : "dense_disabled";
      log.info(
        {
          conversationId: turn.conversationId,
          turnNumber: turn.turnNumber,
          reason,
          pass: true,
        },
        denseEnabled
          ? "memory-v3 injection gate: dense lane unavailable, passing open"
          : "memory-v3 injection gate: dense lane disabled, passing open",
      );
      gateOutcome = { reason, pass: true };
      recordGate({ pass: true, reason, scored: false });
    } else {
      let gate: V3GateResult | null = null;
      try {
        gate = checkV3Gate({
          needleHits: needled,
          denseHits: liveDensed,
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
        gateOutcome = { reason: "gate_error", pass: true };
        recordGate({ pass: true, reason: "gate_error", scored: false });
      }
      if (gate) {
        log.info(
          {
            conversationId: turn.conversationId,
            turnNumber: turn.turnNumber,
            gate,
          },
          "memory-v3 injection gate decision",
        );
        gateOutcome = { reason: gate.reason, pass: gate.pass };
        recordGate({
          pass: gate.pass,
          reason: gate.reason,
          scored: true,
          top_dense_score: gate.topDenseScore,
          top_norm_sparse_score: gate.topNormSparseScore,
          checked_articles: gate.checkedArticles,
        });
        if (!gate.pass) {
          // A closed gate produces no finder lane; only `selections` and
          // `selectorRan` differ between bypass (stable prefix) and hard-skip.
          const closed = (
            selections: SelectedPage[],
            selectorRan: boolean,
          ): OrchestrateResult => ({
            selections,
            lanes: { core, hot, fresh, always, finder: [] },
            selectorRan,
          });
          if (deps.gateConfig.bypassForCore) {
            // Select over the stable prefix only. `runSelection` mirrors the
            // normal path: with the selector off it passes the stable candidates
            // straight through rather than forcing the selectPool LLM call —
            // which a selector-disabled assistant has no provider for, so it
            // throws MemoryV3RetrievalUnavailableError and escapes the gate on a
            // benign low-signal turn. Reaching here means the assistant is
            // explicitly configured with `selectorEnabled: false` AND
            // `denseK > 0` (the dense-gated gate only runs with dense hits; the
            // new-user profile sets `denseK: 0`, so the gate never runs for it).
            const stableOnly = buildStable();
            const { selections: bypassed, keptAll } = await runSelection({
              stable: stableOnly,
              finder: [],
            });
            recordSelection(bypassed, stableOnly.length, keptAll);
            return closed(bypassed, selectorRanOver(stableOnly.length));
          }
          // Hard skip: the selector is never consulted, so this is a zero
          // selection BY CONSTRUCTION, not a judgment that nothing was relevant.
          // `selector_ran: false` keeps it out of any relevance rate, and the
          // result's `selectorRan` keeps it out of the persisted pool record.
          recordSelection([], 0, false);
          return closed([], false);
        }
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
  // section for edge-only pages (pass `undefined`): the candidate is a
  // section-less line and a selection of it injects the page's lead.
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
    alive: (slug) => !finderByArticle.has(slug) && !stablePrefix.has(slug),
  });
  for (const neighbor of surfaced) {
    const best = deps.needle.bestSection(neighbor.article, turn.currentMessage);
    const fallbackDescriptor = best >= 0 ? sections[best]?.text : undefined;
    addNeighbour(
      neighbor.article,
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
      alive: (slug) => !finderByArticle.has(slug) && !stablePrefix.has(slug),
    });
    for (const neighbor of learned) {
      const best = deps.needle.bestSection(
        neighbor.article,
        turn.currentMessage,
      );
      addNeighbour(
        neighbor.article,
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
  // merges selections per slug. Each line carries its matched section and
  // snippet terms; a candidate with no match text falls back to the page's
  // lead-section snippet.
  const stable = buildStable();
  const finderTail: PoolCandidate[] = finder.map((c) => ({
    slug: c.slug,
    lane: c.lane,
    section: c.section,
    terms: c.terms,
    descriptor:
      c.descriptor.trim().length > 0
        ? c.descriptor
        : leadSectionText(deps.sectionIndex, c.slug),
  }));

  // Step 3: a SINGLE forced-tool select over the cache-ordered pool. The
  // selections come back slug-deduped (`selectPool`'s contract).
  // `selectorPrompt` is the (optionally overridden) instruction scaffold;
  // `undefined` falls through to the bundled default.
  const pool = { stable, finder: finderTail };
  recordLatencySubSpan(
    "v3_expand",
    "Gate & edge expansion",
    Date.now() - expandStartedAt,
  );
  const poolSize = stable.length + finderTail.length;
  const { selections, keptAll } = await runSelection(pool);
  recordSelection(selections, poolSize, keptAll);

  return {
    selections,
    lanes: { core, hot, fresh, always, finder },
    selectorRan: selectorRanOver(poolSize),
  };
}

/**
 * Resolve a dense-lane hit's matched ordinal to its index into
 * `index.sections`. The dense store keys sections by `(article, ordinal)`, so
 * we scan the article's sections for the matching ordinal. Returns
 * `undefined` when the article or ordinal is not in the index (e.g. the dense
 * store is ahead of the in-memory rebuild).
 */
function sectionDocByOrdinal(
  index: SectionIndex,
  article: Slug,
  ordinal: number,
): number | undefined {
  for (const doc of index.byArticle.get(article) ?? []) {
    if (index.sections[doc]?.ordinal === ordinal) {
      return doc;
    }
  }
  return undefined;
}

/** The concrete `Section` a dense-lane hit's ordinal resolves to; see
 *  {@link sectionDocByOrdinal}. */
export function sectionByOrdinal(
  index: SectionIndex,
  article: Slug,
  ordinal: number,
): Section | undefined {
  const doc = sectionDocByOrdinal(index, article, ordinal);
  return doc === undefined ? undefined : index.sections[doc];
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
