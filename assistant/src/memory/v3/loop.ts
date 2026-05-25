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
 *   3. {@link runTreeWalk}    — scout-seeded hierarchical descent. Seeded by the
 *                               surviving scout slugs (their tree parents) so
 *                               descent starts near where the lanes landed but
 *                               still fans out from the root.
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
 * Cross-pass accumulation. A `visited` candidate accumulator deduplicates slugs
 * across passes by canonical slug, tagging each with the first lane that
 * surfaced it (`sourceBySlug`). The full {@link DescentTrace} carries one
 * {@link DescentPass} per pass (scouts / treeLevels / edgeExpansions / gate),
 * and {@link RetrievalCost} (wall-clock `ms`, the one dimension observable at
 * this composition layer) accumulates across every pass.
 */

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
import { expandEdges } from "./edges.js";
import { filterDenseHits } from "./filter.js";
import { runGate } from "./gate.js";
import { runScouts } from "./scouts.js";
import { getTreeIndex } from "./tree-index.js";
import { runTreeWalk } from "./tree-walk.js";

/** Lane label used to tag each selected slug's provenance in `sourceBySlug`. */
type LaneSource = "hot" | "sparse" | "dense" | "tree" | "edge";

/** Injected dependencies — the SQLite handle the scout hot lane reads. */
export interface RetrievalLoopDeps {
  db: DrizzleDb;
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

  // Cross-pass accumulators.
  const sourceBySlug = new Map<string, LaneSource>();
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

    // 1. Scouts — always-on hot / sparse / dense fanout.
    const scoutResult = await runScouts(passInput, { db: deps.db });
    for (const slug of scoutResult.sticky) sticky.add(slug);

    // Tag hot + sparse scout hits with their lane (first lane wins). Dense
    // slugs are tagged only if they survive the filter below — a dropped dense
    // near-neighbor never enters the candidate set, so it earns no source tag.
    for (const scout of scoutResult.scouts) {
      if (scout.lane === "dense") continue;
      for (const slug of scout.slugs) tagSlug(sourceBySlug, slug, scout.lane);
    }

    // 2. Dense filter — judges only the dense lane (hot/sparse bypass it). The
    // surviving dense slugs replace the raw dense candidates in the running set.
    const denseScout = scoutResult.scouts.find((s) => s.lane === "dense");
    const candidates = new Set<string>();

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
      });
      for (const slug of filtered.kept) {
        candidates.add(slug);
        tagSlug(sourceBySlug, slug, "dense");
      }
      if (filtered.failureReason !== undefined) {
        failureReason = filtered.failureReason;
      }
    }

    // The surviving scout slugs (kept dense + hot + sparse) seed the tree walk.
    const survivingSeeds = [...candidates];

    // 3. Tree walk — scout-seeded hierarchical descent. Gated by `lanes.tree`.
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
        seeds: survivingSeeds,
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
      });
      edgeExpansions = expansion.expansions;
      for (const slug of expansion.pulled) {
        candidates.add(slug);
        tagSlug(sourceBySlug, slug, "edge");
      }
    }

    // 5. Gate — one capable LLM call over the unioned candidate set.
    const gateResult = await runGate({
      input: passInput,
      candidates,
      sticky,
      passNumber,
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
 * Tag `slug`'s provenance with `lane`, keeping the first lane that surfaced it.
 * The pass order (scouts → tree → edge) gives a deterministic precedence: a
 * slug first seen by a scout lane keeps that label even when the tree or edge
 * lane re-surfaces it.
 */
function tagSlug(
  sourceBySlug: Map<string, LaneSource>,
  slug: string,
  lane: LaneSource,
): void {
  if (!sourceBySlug.has(slug)) sourceBySlug.set(slug, lane);
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
