/**
 * Memory v3 — retrieval-loop orchestration.
 *
 * The composition layer that wires the v3 lanes into a single bounded-descent
 * retrieval loop. Each pass runs the lanes in a fixed order:
 *
 *   1. {@link runScouts}      — always-on hot / sparse / dense fanout. Surfaces
 *                               candidate slugs plus the `sticky` (keep-in-the-
 *                               running) and `bypass` (skip-the-tree) sets.
 *   2. {@link filterDenseHits} — one cheap LLM call over the *dense* lane only.
 *                               Hot + near-exact-sparse hits arrive via
 *                               sticky/bypass and are never judged; the dense
 *                               near-neighbors are filtered down to meaningful
 *                               associations.
 *   3. {@link runTreeWalk}    — root-only hierarchical descent that selects
 *                               pages per node. Scout hits steer it as descend
 *                               pressure in the prompt; the descender keeps only
 *                               the relevant leaf pages it finds.
 *   4. {@link expandEdges}    — provider-free 1–2 hop curated-graph expansion
 *                               over every accumulated confident seed.
 *   5. {@link runGate}        — one capable LLM call over the unioned candidate
 *                               set. Returns `ready` (finalize) or `more`
 *                               (its generated follow-up questions seed the next
 *                               pass's query).
 *
 * Pass control. The loop runs at most `config.memory.v3.passCap` passes. When
 * the gate says `more` and another pass is allowed, the gate's questions become
 * the next pass's query (folded into `nowText`); otherwise the loop force-exits
 * with the current selection. The standing-context files conveyed via
 * `input.nowText` are consumed as situational context for the scouts, descent,
 * and gate — the loop selects concept pages to layer on top and NEVER rewrites
 * or re-injects the standing-context files.
 *
 * Lane toggles. `config.memory.v3.lanes.tree` and `.edges` gate the tree-walk
 * and edge-expansion lanes here; the hot/sparse/dense toggles are honored inside
 * {@link runScouts}. Toggling a lane off removes its contribution from the
 * candidate set so the offline harness can measure each lane's marginal recall.
 *
 * Cross-pass accumulation. The `candidates` pool is unioned across every pass
 * and the gate judges that cumulative pool, so a multi-pass `more` never drops
 * the non-sticky hits earlier passes surfaced. Each slug is tagged with the
 * most trusted lane that surfaced it (`sourceBySlug`). The full
 * {@link DescentTrace}
 * carries one {@link DescentPass} per pass (scouts / treeLevels /
 * edgeExpansions / gate), and {@link RetrievalCost} (wall-clock `ms`, the one
 * dimension observable at this composition layer) accumulates across every pass.
 */

import { getLogger } from "../../util/logger.js";
import type { DrizzleDb } from "../db-connection.js";
import type {
  RetrievalCost,
  RetrievalInput,
  RetrievalOutput,
} from "../v2/harness/retriever.js";
import type {
  DescentPass,
  DescentTrace,
  GateDecision,
} from "../v2/harness/trace.js";
import { getPageIndex } from "../v2/page-index.js";
import { aboveThreshold } from "./auto-edges.js";
import {
  type CoactivationRow,
  recordCoactivations,
} from "./coactivation-store.js";
import { expandEdges } from "./edges.js";
import { filterDenseHits } from "./filter.js";
import { runGate } from "./gate.js";
import type { LlmCallRecord, LlmCallSink } from "./llm-capture.js";
import { runScouts } from "./scouts.js";
import { getTreeIndex } from "./tree-index.js";
import { runTreeWalk } from "./tree-walk.js";

/** Lane label used to tag each selected slug's provenance in `sourceBySlug`. */
type LaneSource = "hot" | "sparse" | "dense" | "tree" | "edge";

const log = getLogger("memory-v3-loop");

/** Injected dependencies — the SQLite handle the scout hot lane reads. */
export interface RetrievalLoopDeps {
  db: DrizzleDb;
  /**
   * Conversation this retrieval is running for. Stamped on co-activation rows
   * when `config.memory.v3.write.coactivation` is on. Empty string when the
   * loop runs in the offline harness (no live conversation).
   */
  conversationId?: string;
  /** Turn number within the conversation, for co-activation provenance. */
  turn?: number;
  /**
   * Optional debug sink. When set, every v3 LLM call (filter / each descender /
   * gate) emits one {@link LlmCallRecord} with its full input + raw response.
   * Undefined on the live/shadow path, so production captures nothing.
   */
  capture?: (record: LlmCallRecord) => void;
}

/**
 * Run the full v3 retrieval loop for one turn.
 *
 * Composes the scout / filter / tree / edge / gate lanes over up to
 * `config.memory.v3.passCap` passes, returning the P1 {@link RetrievalOutput}:
 * the final selection, per-lane provenance, the complete multi-pass
 * {@link DescentTrace}, and accumulated {@link RetrievalCost}. `failureReason`
 * is set when the dense filter had to fail open on any pass (the loop still
 * returns a usable selection — the filter degradation is recorded, not fatal).
 */
export async function runRetrievalLoop(
  input: RetrievalInput,
  deps: RetrievalLoopDeps,
): Promise<RetrievalOutput> {
  const v3 = input.config.memory.v3;
  const passCap = Math.max(1, v3.passCap);
  const lanes = v3.lanes;

  // Learned co-retrieval adjacency (memory_v3_auto_edges), read once and merged
  // into the edge lane's curated graph when the threshold is set. At threshold 0
  // (the default) this is undefined and edge behavior is identical to before.
  const learnedAdjacencyThreshold = v3.edges?.learnedAdjacencyThreshold ?? 0;
  const learnedAdjacency =
    learnedAdjacencyThreshold > 0
      ? aboveThreshold(deps.db, learnedAdjacencyThreshold)
      : undefined;

  // Cross-pass accumulators.
  const sourceBySlug = new Map<string, LaneSource>();
  // Candidate pool unioned across every pass. Each pass adds its own surfaced
  // slugs (hot/sparse, dense-filter survivors, tree, edge) and the gate judges
  // the cumulative pool, so a multi-pass `more` never discards earlier passes'
  // non-sticky hits.
  const candidates = new Set<string>();
  // The first pass each slug entered the candidate set. Drives co-activation
  // emission below — pass-1 hits (gap source) vs. later-surfaced pages (target).
  const firstPassBySlug = new Map<string, number>();
  const sticky = new Set<string>();
  const passes: DescentPass[] = [];
  // `ms` is the one cost dimension observable at this composition layer — the
  // lanes consume their own LLM usage internally and don't surface tokens.
  const cost: RetrievalCost & { ms: number } = { ms: 0 };
  let failureReason: string | null = null;

  // The query feeding each pass. Pass 1 uses the turn's NOW context verbatim;
  // a gate `more` verdict appends its generated follow-up questions for the
  // next pass. The standing-context files are never rewritten — questions are
  // layered on as additional situational context only.
  let passNowText = input.nowText;

  // Final selection — replaced by the gate each pass; the last pass's selection
  // is what the loop returns (capped at passCap on a forced exit).
  let selectedSlugs: string[] = [];

  for (let passNumber = 1; passNumber <= passCap; passNumber++) {
    const passStart = Date.now();
    const passInput: RetrievalInput = { ...input, nowText: passNowText };

    // Per-pass capture sink: stamp the current pass onto each lane's emitted
    // record. Stays undefined (inert) unless a capture sink was injected.
    const sink = deps.capture;
    const passSink: LlmCallSink | undefined = sink
      ? (record) => sink({ ...record, pass: passNumber })
      : undefined;

    // 1. Scouts — always-on hot / sparse / dense fanout.
    const scoutResult = await runScouts(passInput, { db: deps.db });
    for (const slug of scoutResult.sticky) sticky.add(slug);

    // Tag hot + sparse scout hits with their lane (most trusted lane wins —
    // see tagSlug). Dense slugs are tagged only if they survive the filter
    // below — a dropped dense near-neighbor never enters the candidate set, so
    // it earns no source tag.
    for (const scout of scoutResult.scouts) {
      if (scout.lane === "dense") continue;
      for (const slug of scout.slugs) tagSlug(sourceBySlug, slug, scout.lane);
    }

    // 2. Dense filter — judges only the dense lane (hot/sparse bypass it). Only
    // the surviving dense slugs enter the candidate pool; a dropped dense
    // near-neighbor never joins it (and so never reaches the gate).
    const denseScout = scoutResult.scouts.find((s) => s.lane === "dense");

    // Hot + sparse lane hits enter the candidate set directly.
    for (const scout of scoutResult.scouts) {
      if (scout.lane === "dense") continue;
      for (const slug of scout.slugs) candidates.add(slug);
    }

    if (denseScout) {
      const filtered = await filterDenseHits({
        input: passInput,
        dense: denseScout,
        sticky: scoutResult.sticky,
        bypass: scoutResult.bypass,
        capture: passSink,
      });
      for (const slug of filtered.kept) {
        candidates.add(slug);
        tagSlug(sourceBySlug, slug, "dense");
      }
      if (filtered.failureReason !== undefined) {
        failureReason = filtered.failureReason;
      }
    }

    // 3. Tree walk — root-only hierarchical descent that selects pages per
    // node. Scout hits steer it as descend pressure in the prompt (the scout
    // pages themselves already entered `candidates` above). Gated by `lanes.tree`.
    let treeLevels: DescentPass["treeLevels"];
    if (lanes.tree) {
      const [tree, pages] = await Promise.all([
        getTreeIndex(passInput.workspaceDir),
        getPageIndex(passInput.workspaceDir),
      ]);
      const walk = await runTreeWalk({
        input: passInput,
        tree,
        pages,
        scouts: scoutResult.scouts,
        capture: passSink,
      });
      treeLevels = walk.levels;
      for (const slug of walk.pages) {
        candidates.add(slug);
        tagSlug(sourceBySlug, slug, "tree");
      }
    }

    // 4. Edge expansion — 1–2 hop curated-graph pull over every accumulated
    // confident seed. Gated by `lanes.edges`.
    let edgeExpansions: DescentPass["edgeExpansions"];
    if (lanes.edges) {
      const expansion = await expandEdges({
        workspaceDir: passInput.workspaceDir,
        seeds: [...candidates],
        // Rank seeds by the lane that surfaced them (tree/dense/sparse before
        // hot) so the seed cap spends its budget on query-relevant seeds, not
        // recency. `sourceBySlug` holds each candidate's first-seen lane.
        laneBySlug: sourceBySlug,
        // Merge the learned co-retrieval graph with the curated edges when
        // enabled (undefined = curated-only, the default).
        ...(learnedAdjacency ? { extraAdjacency: learnedAdjacency } : {}),
      });
      edgeExpansions = expansion.expansions;
      for (const slug of expansion.pulled) {
        candidates.add(slug);
        tagSlug(sourceBySlug, slug, "edge");
      }
    }

    // Record the first pass each candidate surfaced on. The candidate set is
    // the union of every lane's contribution this pass; a slug keeps the
    // earliest pass it appeared on (first write wins).
    for (const slug of candidates) {
      if (!firstPassBySlug.has(slug)) firstPassBySlug.set(slug, passNumber);
    }

    // When gateCandidateSummaries is enabled (opt-in), render candidates to the
    // gate as `slug — summary` so it can judge relevance on page content rather
    // than the slug alone. getPageIndex is cached, so this reuses the index the
    // scouts/tree lanes already built this pass.
    let summaryBySlug: Map<string, string> | undefined;
    if (passInput.config.memory.v3.gateCandidateSummaries) {
      const pageIndex = await getPageIndex(passInput.workspaceDir);
      summaryBySlug = new Map<string, string>();
      for (const slug of candidates) {
        const summary = pageIndex.bySlug.get(slug)?.summary;
        if (summary) summaryBySlug.set(slug, summary);
      }
    }

    // 5. Gate — one capable LLM call over the unioned candidate set.
    const gateResult = await runGate({
      input: passInput,
      candidates,
      sticky,
      passNumber,
      summaryBySlug,
      capture: passSink,
    });
    selectedSlugs = gateResult.selectedSlugs;

    // Record this pass's trace.
    const pass: DescentPass = {
      passNumber,
      scouts: scoutResult.scouts,
      ...(treeLevels !== undefined ? { treeLevels } : {}),
      ...(edgeExpansions !== undefined ? { edgeExpansions } : {}),
      gate: gateResult.decision,
    };
    passes.push(pass);

    cost.ms += Date.now() - passStart;

    // Pass control. A `more` verdict with another pass available feeds the
    // gate's generated questions into the next pass's query; otherwise (ready,
    // or passCap reached) the loop exits with the current selection.
    if (gateResult.decision.decision !== "more") break;
    if (passNumber >= passCap) break;
    passNowText = nextPassNowText(input.nowText, gateResult.decision);
  }

  // Co-activation logging — off the critical path. Gated by
  // `write.coactivation` (default off). Emits one pass-1 → pass-N pair per
  // (pass-1 hit, later-surfaced page) in the final selection. Best-effort:
  // wrapped so neither the computation nor the insert can delay or break the
  // RetrievalOutput the caller depends on.
  if (v3.write?.coactivation) {
    emitCoactivations({
      db: deps.db,
      conversationId: deps.conversationId ?? "",
      turn: deps.turn ?? 0,
      selectedSlugs,
      firstPassBySlug,
    });
  }

  const trace: DescentTrace = { passes };
  return {
    selectedSlugs,
    sourceBySlug,
    trace,
    cost,
    failureReason,
  };
}

/**
 * Emit pass-1 → pass-N co-activation rows for the final selection.
 *
 * For each selected page B first surfaced on pass ≥2, pair it with each
 * selected page A first surfaced on pass 1 (`pass_gap = passOf(B) − 1`). Pages
 * only surfaced on pass 1 (or never recorded) emit nothing — the gradient is
 * the gap between an early hit and a later-surfaced association. `used` is 0:
 * the loop cannot know whether B was load-bearing for the turn; edge-learning
 * reconciles usefulness later.
 *
 * Best-effort and off the retrieval critical path — any failure is swallowed.
 */
function emitCoactivations(args: {
  db: DrizzleDb;
  conversationId: string;
  turn: number;
  selectedSlugs: readonly string[];
  firstPassBySlug: ReadonlyMap<string, number>;
}): void {
  try {
    const { db, conversationId, turn, selectedSlugs, firstPassBySlug } = args;
    const pass1Hits = selectedSlugs.filter(
      (slug) => firstPassBySlug.get(slug) === 1,
    );
    if (pass1Hits.length === 0) return;

    const createdAt = Date.now();
    const rows: CoactivationRow[] = [];
    for (const target of selectedSlugs) {
      const targetPass = firstPassBySlug.get(target);
      if (targetPass === undefined || targetPass < 2) continue;
      for (const source of pass1Hits) {
        rows.push({
          conversationId,
          turn,
          sourceSlug: source,
          targetSlug: target,
          passGap: targetPass - 1,
          used: 0,
          createdAt,
        });
      }
    }

    recordCoactivations(db, rows);
  } catch (err) {
    log.warn({ err }, "failed to emit co-activations; continuing");
  }
}

/**
 * Lane-trust order for `sourceBySlug` provenance (lower = more trusted). A slug
 * surfaced by several lanes is tagged with the most trusted one. Mirrors
 * `SEED_LANE_RANK` in {@link expandEdges}'s module, the downstream consumer that
 * ranks seeds by this tag before the candidate cap: LLM-vetted tree/dense seeds
 * rank above lexical sparse, recency-only hot, and associative edge pulls.
 * Keeping the two orders aligned ensures the upgrade picks the lane the cap
 * actually trusts. Any lane absent here (or an edge pull) ranks last.
 */
const LANE_TRUST_RANK: Readonly<Record<LaneSource, number>> = {
  tree: 0,
  dense: 1,
  sparse: 2,
  hot: 3,
  edge: 4,
};

/**
 * Tag `slug`'s provenance with `lane`, upgrading to the most trusted lane that
 * surfaces it (see {@link LANE_TRUST_RANK}). A slug first seen via a low-trust
 * lane (e.g. `edge`) is relabeled when a higher-trust lane (e.g. `dense`) also
 * surfaces it, so the downstream seed cap ranks it by its strongest signal
 * rather than a stale first-seen lane. Pass provenance (`firstPassBySlug`) is
 * tracked separately and keeps earliest-pass semantics — only the lane upgrades.
 */
function tagSlug(
  sourceBySlug: Map<string, LaneSource>,
  slug: string,
  lane: LaneSource,
): void {
  const current = sourceBySlug.get(slug);
  if (
    current === undefined ||
    LANE_TRUST_RANK[lane] < LANE_TRUST_RANK[current]
  ) {
    sourceBySlug.set(slug, lane);
  }
}

/**
 * Build the next pass's NOW text from the original standing context plus the
 * gate's generated follow-up questions. The standing-context files are never
 * rewritten — the questions are appended as an additional situational-context
 * block the scouts/descent/gate read on top of NOW. With no questions the
 * original NOW is reused verbatim.
 */
function nextPassNowText(baseNowText: string, decision: GateDecision): string {
  const questions = decision.questions ?? [];
  if (questions.length === 0) return baseNowText;
  const block = `<follow_up_questions>\n${questions.join("\n")}\n</follow_up_questions>`;
  return `${baseNowText}\n\n${block}`;
}
