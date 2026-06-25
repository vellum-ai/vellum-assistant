/**
 * Deterministic unblind + tally for the memory-v3 corpus eval gate.
 *
 * The blind-judge workflow returns one verdict per packet (A vs B) without
 * knowing which side is which; `eval` writes a separate per-turn `key.json`
 * mapping A/B → snapshot/staging. This module joins the two and produces the
 * gate verdict, replacing an ad-hoc hand tally.
 *
 * Two failure modes this exists to prevent (both seen in the field):
 *
 * 1. **A/B is shuffled PER TURN** (a single run has A=snapshot on some turns
 *    and A=staging on others). A global "A won N times" count is meaningless —
 *    the winner must be mapped through the key turn-by-turn. A hand tally that
 *    assumed "A == snapshot" for the whole run flipped the result.
 * 2. **Win-count over near-tied per-turn scores amplifies judge noise.** When
 *    most decided turns hinge on a single point of a 0–10 score, a 12–11 split
 *    is a coin flip, not a loss. The gate therefore applies a two-sided sign
 *    test: the wiki only FAILS when the snapshot's win lead is statistically
 *    significant. "Win or tie" passes; a within-noise difference is a tie.
 *
 * Supports a judge PANEL: pass multiple verdicts per turn (e.g. K judges, or
 * the same set re-judged under different seeds) and each turn is decided by the
 * panel's majority before the set-level tally. A larger panel tightens the
 * per-turn signal that the sign test then aggregates.
 */

import type { EvalKeyEntry } from "./eval-packets.js";

/** One judge's verdict for one packet (the blind-judge workflow's leaf output). */
export interface JudgeVerdict {
  turn: string;
  /** The judge's explicit call. When absent/invalid it is derived from scores. */
  winner?: "A" | "B" | "tie" | string;
  scoreA: number;
  scoreB: number;
}

export interface TallyOptions {
  /** Significance threshold for the two-sided sign test (default 0.05). */
  alpha?: number;
  /** Minimum decided turns to call the result confident (default 10). */
  minDecided?: number;
  /** Minimum mean panel votes/turn to call the result confident (default 3). */
  minPanel?: number;
}

export interface TallyResult {
  /** Distinct turns with at least one verdict matched to the key. */
  turns: number;
  verdictsCounted: number;
  /** Verdicts whose `turn` had no key entry (ignored). */
  unmatchedVerdicts: number;
  /** Votes per turn across the panel. */
  panel: { min: number; max: number; mean: number };
  snapshotWins: number;
  stagingWins: number;
  ties: number;
  /** snapshotWins + stagingWins (turns that were not a tie). */
  decided: number;
  /** Mean per-turn score for each corpus (each turn weighted equally). */
  meanSnapshot: number;
  meanStaging: number;
  /** Two-sided binomial sign-test p-value for the snapshot/staging win split. */
  signTestP: number;
  /** wiki-wins / tie / wiki-loses — significance-gated, not raw count. */
  verdict: "wiki-wins" | "tie" | "wiki-loses";
  /** The ship gate: the wiki must win OR tie, so `fail` iff `wiki-loses`. */
  gate: "pass" | "fail";
  /** Enough decided turns + panel votes to trust the verdict. */
  confident: boolean;
  notes: string[];
}

/**
 * Two-sided binomial sign-test p-value for a split of `a` vs `b` successes under
 * H0 p=0.5. Computed in log space (via log-factorials) so it is stable for the
 * few-hundred-turn range without overflowing `2^n`.
 */
export function binomialTwoSidedSignP(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const logFact: number[] = new Array(n + 1);
  logFact[0] = 0;
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1]! + Math.log(i);
  const logChoose = (k: number): number =>
    logFact[n]! - logFact[k]! - logFact[n - k]!;
  const hi = Math.max(a, b);
  let tail = 0;
  for (let k = hi; k <= n; k++) {
    tail += Math.exp(logChoose(k) - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Resolve a verdict's winning corpus, deriving from scores if `winner` is unusable. */
function winnerSide(
  v: JudgeVerdict,
  key: EvalKeyEntry,
): "snapshot" | "staging" | "tie" {
  let w = v.winner;
  if (w !== "A" && w !== "B" && w !== "tie") {
    w = v.scoreA > v.scoreB ? "A" : v.scoreB > v.scoreA ? "B" : "tie";
  }
  if (w === "tie") return "tie";
  return w === "A" ? key.a : key.b;
}

/**
 * Join judge verdicts to the unblinding key and produce the gate verdict.
 * Pure over its inputs.
 */
export function tallyVerdicts(
  verdicts: JudgeVerdict[],
  key: EvalKeyEntry[],
  opts: TallyOptions = {},
): TallyResult {
  const alpha = opts.alpha ?? 0.05;
  const minDecided = opts.minDecided ?? 10;
  const minPanel = opts.minPanel ?? 3;

  const keyByTurn = new Map(key.map((k) => [k.turn, k]));
  const byTurn = new Map<
    string,
    {
      sides: ("snapshot" | "staging" | "tie")[];
      snap: number[];
      stage: number[];
    }
  >();
  let unmatched = 0;
  let counted = 0;
  for (const v of verdicts) {
    const k = keyByTurn.get(v.turn);
    if (!k) {
      unmatched++;
      continue;
    }
    counted++;
    let g = byTurn.get(v.turn);
    if (!g) {
      g = { sides: [], snap: [], stage: [] };
      byTurn.set(v.turn, g);
    }
    g.sides.push(winnerSide(v, k));
    g.snap.push(k.a === "snapshot" ? v.scoreA : v.scoreB);
    g.stage.push(k.a === "snapshot" ? v.scoreB : v.scoreA);
  }

  let snapshotWins = 0;
  let stagingWins = 0;
  let ties = 0;
  let sumSnap = 0;
  let sumStage = 0;
  const panelSizes: number[] = [];
  for (const g of byTurn.values()) {
    panelSizes.push(g.sides.length);
    const nSnap = g.sides.filter((s) => s === "snapshot").length;
    const nStage = g.sides.filter((s) => s === "staging").length;
    if (nStage > nSnap) stagingWins++;
    else if (nSnap > nStage) snapshotWins++;
    else ties++; // tie vote, or equal snapshot/staging votes
    sumSnap += mean(g.snap);
    sumStage += mean(g.stage);
  }

  const turns = byTurn.size;
  const decided = snapshotWins + stagingWins;
  const signTestP = binomialTwoSidedSignP(snapshotWins, stagingWins);

  let verdict: TallyResult["verdict"];
  if (stagingWins > snapshotWins && signTestP < alpha) verdict = "wiki-wins";
  else if (snapshotWins > stagingWins && signTestP < alpha)
    verdict = "wiki-loses";
  else verdict = "tie";
  const gate: "pass" | "fail" = verdict === "wiki-loses" ? "fail" : "pass";

  const panel = {
    min: panelSizes.length ? Math.min(...panelSizes) : 0,
    max: panelSizes.length ? Math.max(...panelSizes) : 0,
    mean: mean(panelSizes),
  };
  const confident = decided >= minDecided && panel.mean >= minPanel;

  const notes: string[] = [];
  if (turns === 0) {
    notes.push(
      "No verdicts matched the key — check the verdicts/key files are from the same run.",
    );
  }
  if (turns > 0 && panel.mean < minPanel) {
    notes.push(
      `Low panel size (mean ${panel.mean.toFixed(1)} votes/turn) — single-vote judging is noisy; ` +
        `re-judge with a panel (K judges per turn) or repeat under multiple --seed values.`,
    );
  }
  if (turns > 0 && decided < minDecided) {
    notes.push(
      `Only ${decided} decided turns — too few to be confident; mine more turns.`,
    );
  }
  if (unmatched > 0) {
    notes.push(
      `${unmatched} verdict(s) had no matching key entry and were ignored.`,
    );
  }
  if (verdict === "tie") {
    notes.push(
      "Snapshot vs wiki is within noise — a tie satisfies the win-or-tie gate, " +
        "but the wiki did not clearly beat the current corpus.",
    );
  }

  return {
    turns,
    verdictsCounted: counted,
    unmatchedVerdicts: unmatched,
    panel,
    snapshotWins,
    stagingWins,
    ties,
    decided,
    meanSnapshot: turns ? sumSnap / turns : 0,
    meanStaging: turns ? sumStage / turns : 0,
    signTestP,
    verdict,
    gate,
    confident,
    notes,
  };
}
