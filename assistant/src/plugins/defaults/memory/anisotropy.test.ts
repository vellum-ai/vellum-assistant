import { describe, expect, test } from "bun:test";

import {
  type AnisotropyCalibration,
  applyAnisotropyCorrection,
  explainedVarianceRatio,
  fitAnisotropyCalibration,
} from "./anisotropy.js";

const META = { provider: "gemini" as const, model: "test-model" };

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function l2Norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

function l2Normalize(v: readonly number[]): number[] {
  const n = l2Norm(v);
  if (n === 0) return [...v];
  return v.map((x) => x / n);
}

/**
 * Build a synthetic anisotropic corpus: every sample lives close to a fixed
 * direction `axis`, with small Gaussian-ish noise injected in the orthogonal
 * subspace. This gives us a known top-1 PC the fit must recover.
 */
function buildAnisotropicCorpus(
  n: number,
  dim: number,
  axis: readonly number[],
  noiseScale: number,
): number[][] {
  const ax = l2Normalize(axis);
  const out: number[][] = [];
  let seed = 42;
  const rand = () => {
    // Tiny deterministic LCG so tests don't depend on Math.random.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const v = new Array<number>(dim);
    // Strong common direction component, slightly varied per sample.
    const along = 1 + (rand() - 0.5) * 0.1;
    for (let j = 0; j < dim; j++) v[j] = along * ax[j];
    // Orthogonal noise.
    for (let j = 0; j < dim; j++) v[j] += (rand() - 0.5) * noiseScale;
    out.push(v);
  }
  return out;
}

describe("fitAnisotropyCalibration", () => {
  test("recovers the dominant direction of an anisotropic corpus", () => {
    const dim = 16;
    const axis = new Array<number>(dim)
      .fill(0)
      .map((_, i) => (i === 0 ? 1 : 0));
    const corpus = buildAnisotropicCorpus(200, dim, axis, 0.05);

    const calib = fitAnisotropyCalibration(corpus, 1, META);

    expect(calib.components.length).toBe(1);
    expect(calib.components[0].length).toBe(dim);
    // PC1 should align with the planted axis (sign-agnostic).
    const alignment = Math.abs(dot(calib.components[0], axis));
    expect(alignment).toBeGreaterThan(0.95);
  });

  test("captures most variance in PC1 for a strongly anisotropic corpus", () => {
    const dim = 16;
    const axis = new Array<number>(dim)
      .fill(0)
      .map((_, i) => (i === 0 ? 1 : 0));
    const corpus = buildAnisotropicCorpus(200, dim, axis, 0.02);

    const calib = fitAnisotropyCalibration(corpus, 3, META);
    const ratios = explainedVarianceRatio(calib);

    // Spectrum is monotonically non-increasing.
    expect(ratios[0]).toBeGreaterThanOrEqual(ratios[1]);
    expect(ratios[1]).toBeGreaterThanOrEqual(ratios[2]);
    // PC1 should dwarf PC2 by an order of magnitude when noise is small.
    expect(ratios[0]).toBeGreaterThan(ratios[1] * 10);
  });

  test("returns mean and dim metadata", () => {
    const dim = 8;
    const corpus = [
      [1, 1, 0, 0, 0, 0, 0, 0],
      [3, 3, 0, 0, 0, 0, 0, 0],
    ];
    const calib = fitAnisotropyCalibration(corpus, 1, META);
    expect(calib.dim).toBe(dim);
    expect(calib.mean[0]).toBeCloseTo(2);
    expect(calib.mean[1]).toBeCloseTo(2);
    expect(calib.mean[2]).toBeCloseTo(0);
    expect(calib.sampleCount).toBe(2);
    expect(calib.provider).toBe("gemini");
    expect(calib.model).toBe("test-model");
  });

  test("rejects empty input, bad k, and ragged rows", () => {
    expect(() => fitAnisotropyCalibration([], 1, META)).toThrow(/no vectors/);
    expect(() => fitAnisotropyCalibration([[1, 2, 3]], 0, META)).toThrow(
      /positive integer/,
    );
    expect(() =>
      fitAnisotropyCalibration(
        [
          [1, 2],
          [3, 4, 5],
        ],
        1,
        META,
      ),
    ).toThrow(/dim/);
    expect(() => fitAnisotropyCalibration([[1, 2]], 5, META)).toThrow(
      /exceeds/,
    );
  });
});

describe("applyAnisotropyCorrection", () => {
  test("output has unit L2 norm", () => {
    const corpus = buildAnisotropicCorpus(
      100,
      8,
      [1, 0, 0, 0, 0, 0, 0, 0],
      0.05,
    );
    const calib = fitAnisotropyCalibration(corpus, 1, META);

    const corrected = applyAnisotropyCorrection(corpus[0], calib);
    expect(l2Norm(corrected)).toBeCloseTo(1, 6);
  });

  test("removes projection onto the dominant direction", () => {
    const dim = 8;
    const axis = [1, 0, 0, 0, 0, 0, 0, 0];
    const corpus = buildAnisotropicCorpus(200, dim, axis, 0.02);
    const calib = fitAnisotropyCalibration(corpus, 1, META);

    // Pick a vector that points strongly along the planted axis.
    const sample = [...axis];
    const corrected = applyAnisotropyCorrection(sample, calib);

    // After removing PC1 (which is ~axis), the projection back onto axis
    // should be nearly zero — the sample is in the deflated subspace.
    expect(Math.abs(dot(corrected, axis))).toBeLessThan(0.05);
  });

  test("spreads cosine similarities for vectors in the cone", () => {
    const dim = 16;
    const axis = new Array<number>(dim)
      .fill(0)
      .map((_, i) => (i === 0 ? 1 : 0));
    const corpus = buildAnisotropicCorpus(300, dim, axis, 0.1);
    const calib = fitAnisotropyCalibration(corpus, 1, META);

    // Compute pairwise cosines on raw vs corrected vectors. The corrected
    // distribution should have noticeably larger spread (max - min) — the
    // whole point of the correction.
    function spread(vectors: number[][]): number {
      const sims: number[] = [];
      for (let i = 0; i < vectors.length; i++) {
        const a = l2Normalize(vectors[i]);
        for (let j = i + 1; j < vectors.length; j++) {
          const b = l2Normalize(vectors[j]);
          sims.push(dot(a, b));
        }
      }
      let min = Infinity;
      let max = -Infinity;
      for (const s of sims) {
        if (s < min) min = s;
        if (s > max) max = s;
      }
      return max - min;
    }

    const rawSpread = spread(corpus.slice(0, 30));
    const correctedSpread = spread(
      corpus.slice(0, 30).map((v) => applyAnisotropyCorrection(v, calib)),
    );

    expect(correctedSpread).toBeGreaterThan(rawSpread * 2);
  });

  test("rejects mismatched dim", () => {
    const calib: AnisotropyCalibration = {
      provider: "gemini",
      model: "x",
      dim: 4,
      mean: [0, 0, 0, 0],
      components: [[1, 0, 0, 0]],
      componentVariance: [1],
      totalVariance: 1,
      sampleCount: 1,
      fitAt: 0,
    };
    expect(() => applyAnisotropyCorrection([1, 2, 3], calib)).toThrow(/dim/);
  });
});

describe("explainedVarianceRatio", () => {
  test("returns zeros when totalVariance is zero", () => {
    const calib: AnisotropyCalibration = {
      provider: "gemini",
      model: "x",
      dim: 2,
      mean: [0, 0],
      components: [[1, 0]],
      componentVariance: [0],
      totalVariance: 0,
      sampleCount: 1,
      fitAt: 0,
    };
    expect(explainedVarianceRatio(calib)).toEqual([0]);
  });

  test("each ratio is variance/total", () => {
    const calib: AnisotropyCalibration = {
      provider: "gemini",
      model: "x",
      dim: 2,
      mean: [0, 0],
      components: [
        [1, 0],
        [0, 1],
      ],
      componentVariance: [3, 1],
      totalVariance: 4,
      sampleCount: 100,
      fitAt: 0,
    };
    const ratios = explainedVarianceRatio(calib);
    expect(ratios[0]).toBeCloseTo(0.75);
    expect(ratios[1]).toBeCloseTo(0.25);
  });
});
