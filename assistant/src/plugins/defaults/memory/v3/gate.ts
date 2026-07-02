// ---------------------------------------------------------------------------
// Memory v3 — per-turn injection gate (pure score check)
// ---------------------------------------------------------------------------
//
// Decides whether the finder-lane retrieval scores clear the injection
// thresholds for this turn. Three ways to pass:
//   - dense_pass:        top-1 dense cosine clears `denseThreshold`.
//   - dense_cluster:     dense top-1 falls short but the whole top-3 dense
//                        cluster sits above `denseClusterThreshold` within a
//                        tight `denseClusterMaxDelta` spread (a coherent-but-
//                        borderline neighbourhood).
//   - sparse_only_strong: dense fails outright but normalized top-1 BM25F clears
//                        the higher `sparseOnlyThreshold` bar.
//
// A zero-overlap hard floor keeps sparse signal honest: a raw BM25F of `0` means
// no query term matched any section, so the sparse lane can never open the gate
// regardless of how the thresholds are tuned.
//
// This module is intentionally PURE — no async, no I/O, no logging, and no
// imports beyond the two scored-hit types. `config.enabled` is the resolved
// injection-gate flag value supplied by the caller, which also feeds in the
// finder-lane hits.

import type { DenseHitScored } from "./dense.js";
import type { SectionNeedleScoredHit } from "./section-needle.js";

/** BM25F normalization constant when config.bm25NormK is null.
 *  TODO(memory-v3): replace with per-corpus auto-calibration. */
export const DEFAULT_BM25_NORM_K = 9.0;

export type V3GateReason =
  | "dense_pass"
  | "dense_cluster"
  | "sparse_only_strong"
  | "fail_no_signal"
  | "fail_dense_below_and_sparse_weak"
  | "disabled";

export interface V3GateConfig {
  enabled: boolean; // effective enable — set from the feature flag in observeTurn
  denseThreshold: number;
  sparseThreshold: number;
  sparseOnlyThreshold: number;
  denseClusterThreshold: number;
  denseClusterMaxDelta: number;
  topK: number;
  bm25NormK: number | null;
  bypassForCore: boolean; // consumed by orchestrate, not by checkV3Gate
}

export interface V3GateResult {
  pass: boolean;
  reason: V3GateReason;
  topDenseScore: number | null;
  topSparseScore: number | null; // raw BM25F
  topNormSparseScore: number | null; // normalized BM25F
  denseScores: number[]; // top-K cosine, desc
  sparseScores: number[]; // top-K raw BM25F, desc
  checkedArticles: number;
}

export interface V3CheckGateParams {
  needleHits: SectionNeedleScoredHit[];
  denseHits: DenseHitScored[];
  config: V3GateConfig;
}

/**
 * Pure injection-gate score check. Given the finder-lane hits and the gate
 * tuning, decides whether retrieval is confident enough to run the selector.
 *
 * `config.bypassForCore` is intentionally NOT read here: whether a closed gate
 * skips entirely versus selecting only the stable core prefix is an
 * orchestrate-level decision, not part of the score check.
 */
export function checkV3Gate(params: V3CheckGateParams): V3GateResult {
  const { needleHits, denseHits, config } = params;

  if (!config.enabled) {
    return {
      pass: true,
      reason: "disabled",
      topDenseScore: null,
      topSparseScore: null,
      topNormSparseScore: null,
      denseScores: [],
      sparseScores: [],
      checkedArticles: 0,
    };
  }

  const k = Math.max(1, config.topK);
  const denseScores = denseHits
    .map((h) => h.score)
    .sort((a, b) => b - a)
    .slice(0, k);
  const sparseScores = needleHits
    .map((h) => h.score)
    .sort((a, b) => b - a)
    .slice(0, k);

  const topDense = denseScores[0] ?? null;
  const topSparseRaw = sparseScores[0] ?? null;

  const normK = config.bm25NormK ?? DEFAULT_BM25_NORM_K;
  const topNorm =
    topSparseRaw === null ? null : topSparseRaw / (topSparseRaw + normK);

  const checkedArticles = new Set(
    [...denseHits, ...needleHits].map((h) => h.article),
  ).size;

  const densePass = topDense !== null && topDense >= config.denseThreshold;

  const top3 = denseScores.slice(0, 3);
  const denseCluster =
    !densePass &&
    top3.length === 3 &&
    top3.every((s) => s >= config.denseClusterThreshold) &&
    top3[0]! - top3[2]! <= config.denseClusterMaxDelta;

  // Hard floor: a raw BM25F of 0 means no query term matched any section, so the
  // sparse lane is treated as carrying no usable signal no matter the thresholds.
  const sparseUsable = topSparseRaw !== null && topSparseRaw > 0;
  const normSparse = sparseUsable ? topNorm! : 0;

  const sparsePass = sparseUsable && normSparse >= config.sparseThreshold;
  const sparseOnlyStrong =
    !(densePass || denseCluster) &&
    sparseUsable &&
    normSparse >= config.sparseOnlyThreshold;

  const pass = densePass || denseCluster || sparseOnlyStrong;

  let reason: V3GateReason;
  if (densePass) {
    reason = "dense_pass";
  } else if (denseCluster) {
    reason = "dense_cluster";
  } else if (sparseOnlyStrong) {
    reason = "sparse_only_strong";
  } else if (sparsePass) {
    reason = "fail_dense_below_and_sparse_weak";
  } else {
    reason = "fail_no_signal";
  }

  return {
    pass,
    reason,
    topDenseScore: topDense,
    topSparseScore: topSparseRaw,
    topNormSparseScore: topNorm, // null only when no sparse hits; 0 when raw is 0
    denseScores,
    sparseScores,
    checkedArticles,
  };
}
