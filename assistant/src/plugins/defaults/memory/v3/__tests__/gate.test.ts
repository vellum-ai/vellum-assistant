import { describe, expect, test } from "bun:test";

import type { DenseHitScored } from "../dense.js";
import {
  checkV3Gate,
  DEFAULT_BM25_NORM_K,
  type V3GateConfig,
} from "../gate.js";
import type { SectionNeedleScoredHit } from "../section-needle.js";

/** Schema tuning defaults (memory.v3.gate) plus the effective `enabled` flag. */
function baseConfig(overrides: Partial<V3GateConfig> = {}): V3GateConfig {
  return {
    enabled: true,
    denseThreshold: 0.52,
    sparseThreshold: 0.35,
    sparseOnlyThreshold: 0.45,
    denseClusterThreshold: 0.47,
    denseClusterMaxDelta: 0.04,
    topK: 5,
    bm25NormK: null,
    bypassForCore: false,
    ...overrides,
  };
}

let articleSeq = 0;
function mkNeedle(score: number, article?: string): SectionNeedleScoredHit {
  return { article: article ?? `needle-${articleSeq++}`, section: 0, score };
}
function mkDense(score: number, article?: string): DenseHitScored {
  return { article: article ?? `dense-${articleSeq++}`, section: 0, score };
}

describe("checkV3Gate", () => {
  test("dense_pass: top-1 dense clears the dense threshold", () => {
    const result = checkV3Gate({
      needleHits: [],
      denseHits: [mkDense(0.6), mkDense(0.3)],
      config: baseConfig(),
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("dense_pass");
    expect(result.topDenseScore).toBe(0.6);
  });

  test("dense_cluster: borderline top-3 dense cluster passes", () => {
    const result = checkV3Gate({
      needleHits: [],
      denseHits: [mkDense(0.5), mkDense(0.48), mkDense(0.47)],
      config: baseConfig(),
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("dense_cluster");
    // Top-1 is below denseThreshold, so this is a cluster pass, not a dense pass.
    expect(result.topDenseScore).toBe(0.5);
  });

  test("sparse_only_strong: dense fails but normalized BM25F clears the high bar", () => {
    const result = checkV3Gate({
      needleHits: [mkNeedle(9)], // norm = 9 / (9 + 9) = 0.5 >= 0.45
      denseHits: [mkDense(0.3), mkDense(0.25)],
      config: baseConfig(),
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("sparse_only_strong");
    expect(result.topSparseScore).toBe(9);
    expect(result.topNormSparseScore).toBeCloseTo(0.5, 10);
  });

  test("fail_dense_below_and_sparse_weak: sparse passes the floor but not the sparse-only bar", () => {
    const result = checkV3Gate({
      needleHits: [mkNeedle(5.52)], // norm = 5.52 / 14.52 ≈ 0.380 (≥ 0.35, < 0.45)
      denseHits: [mkDense(0.3)],
      config: baseConfig(),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("fail_dense_below_and_sparse_weak");
    expect(result.topNormSparseScore!).toBeGreaterThanOrEqual(0.35);
    expect(result.topNormSparseScore!).toBeLessThan(0.45);
  });

  test("fail_no_signal: dense below and sparse essentially nil", () => {
    const result = checkV3Gate({
      needleHits: [mkNeedle(0.1)], // norm ≈ 0.011
      denseHits: [mkDense(0.3)],
      config: baseConfig(),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("fail_no_signal");
  });

  test("hard floor: raw BM25F of 0 never opens the sparse lane even with thresholds at 0", () => {
    const result = checkV3Gate({
      needleHits: [mkNeedle(0)],
      denseHits: [mkDense(0.1)],
      config: baseConfig({ sparseThreshold: 0, sparseOnlyThreshold: 0 }),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("fail_no_signal");
    // Raw 0 is recorded (not null), and its normalized form is exactly 0.
    expect(result.topSparseScore).toBe(0);
    expect(result.topNormSparseScore).toBe(0);
  });

  test("disabled: enabled=false short-circuits to a pass with empty score fields", () => {
    const result = checkV3Gate({
      needleHits: [mkNeedle(9)],
      denseHits: [mkDense(0.9)],
      config: baseConfig({ enabled: false }),
    });
    expect(result).toEqual({
      pass: true,
      reason: "disabled",
      topDenseScore: null,
      topSparseScore: null,
      topNormSparseScore: null,
      denseScores: [],
      sparseScores: [],
      checkedArticles: 0,
    });
  });

  test("empty hits: no signal at all", () => {
    const result = checkV3Gate({
      needleHits: [],
      denseHits: [],
      config: baseConfig(),
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("fail_no_signal");
    expect(result.topDenseScore).toBeNull();
    expect(result.topSparseScore).toBeNull();
    expect(result.topNormSparseScore).toBeNull();
    expect(result.denseScores).toEqual([]);
    expect(result.sparseScores).toEqual([]);
    expect(result.checkedArticles).toBe(0);
  });

  test("bm25NormK override changes the normalized sparse score for the same raw score", () => {
    const params = {
      needleHits: [mkNeedle(9)],
      denseHits: [mkDense(0.3)],
    };
    const withDefault = checkV3Gate({
      ...params,
      config: baseConfig({ bm25NormK: null }),
    });
    const withOverride = checkV3Gate({
      ...params,
      config: baseConfig({ bm25NormK: 1 }),
    });
    // null -> DEFAULT_BM25_NORM_K (9): 9 / 18 = 0.5
    expect(withDefault.topNormSparseScore).toBeCloseTo(
      9 / (9 + DEFAULT_BM25_NORM_K),
      10,
    );
    // override 1: 9 / 10 = 0.9
    expect(withOverride.topNormSparseScore).toBeCloseTo(0.9, 10);
    expect(withOverride.topNormSparseScore).not.toBeCloseTo(
      withDefault.topNormSparseScore!,
      6,
    );
  });

  test("purity: bypassForCore is not read by checkV3Gate", () => {
    const params = {
      needleHits: [mkNeedle(9, "a")],
      denseHits: [mkDense(0.6, "b")],
    };
    const off = checkV3Gate({
      ...params,
      config: baseConfig({ bypassForCore: false }),
    });
    const on = checkV3Gate({
      ...params,
      config: baseConfig({ bypassForCore: true }),
    });
    expect(on).toEqual(off);
  });
});
