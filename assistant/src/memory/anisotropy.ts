// ---------------------------------------------------------------------------
// Embedding anisotropy correction (Mu & Viswanath "all-but-the-top")
// ---------------------------------------------------------------------------
//
// Modern transformer-based embedding models (Gemini's `gemini-embedding-2`
// being the most pronounced offender) produce vectors that occupy a narrow
// cone of the embedding space rather than spreading over the unit sphere.
// The downstream effect is that cosine similarities cluster in a compressed
// range — typically 0.4–0.7 for Gemini — which (a) makes absolute thresholds
// meaningless and (b) lets a few dominant directions drown out semantic
// signal.
//
// The fix: compute the corpus mean and its top-k principal components, then
// post-process every embedding via
//
//     vec' = vec - mean
//     for each pc_i: vec' = vec' - (vec' · pc_i) pc_i
//     vec' = vec' / ||vec'||
//
// k = 1 is the safest starting point and reliably restores spread without
// risking semantic signal — see Mu & Viswanath 2018.
//
// ── Storage ────────────────────────────────────────────────────────────────
//
// Calibrations are persisted as JSON under
// `<workspace>/data/anisotropy/<provider>-<model>-<dim>.json` so each
// (provider, model, dim) tuple has its own. A loaded calibration is cached
// in-process; `clearAnisotropyCacheForTests` resets the module cache.
//
// ── Sphere-vs-raw inputs ───────────────────────────────────────────────────
//
// Qdrant pre-normalises vectors at insert time when the collection uses the
// Cosine distance, so the data we scroll for fitting lives on the unit
// sphere. Gemini's API, by contrast, returns raw (un-normalised) vectors at
// query time. To keep the fit and apply paths consistent we L2-normalise the
// input before applying the correction, regardless of source.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getDataDir } from "../util/platform.js";
import type { EmbeddingProviderName } from "./embedding-types.js";

/** Persisted anisotropy fit for a single (provider, model, dim) tuple. */
export interface AnisotropyCalibration {
  provider: EmbeddingProviderName;
  model: string;
  /** Dimensionality of the embedding vectors this calibration applies to. */
  dim: number;
  /** Per-dimension mean across the fit sample. Length === `dim`. */
  mean: number[];
  /**
   * Top-k principal components to project out. Stored as an array of
   * unit-length d-vectors, one per component, in descending eigenvalue order.
   * `components.length` is the operator-chosen `k` (typically 1, possibly 2-3).
   */
  components: number[][];
  /**
   * Per-component variance (eigenvalues): `‖X v_i‖² / (N - 1)`. Same length
   * as `components`. Useful to validate the fit (PC1 should explain a clear
   * majority of variance for a truly anisotropic embedder).
   */
  componentVariance: number[];
  /**
   * Total variance across all directions: `Σ_i ‖x_i - mean‖² / (N - 1)`.
   * Combine with `componentVariance` to compute the explained-variance ratio
   * per PC — i.e. how much of the corpus variance each PC accounts for.
   */
  totalVariance: number;
  /** Number of vectors used to compute this fit. */
  sampleCount: number;
  /** Wall-clock millis when the fit was computed (Date.now()). */
  fitAt: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fit a calibration: corpus mean + top-k principal components via power
 * iteration with Gram-Schmidt deflation.
 *
 * `vectors` is treated as a row-major data matrix (each entry is one sample).
 * `k` is the number of leading principal components to extract (≥ 1).
 *
 * Returns the calibration without persisting it. Use `saveCalibration` to
 * write it under `<workspace>/data/anisotropy/`.
 *
 * Throws when `vectors` is empty, `k` is non-positive, or the row dimensions
 * disagree — these are caller bugs, not transient failures.
 */
export function fitAnisotropyCalibration(
  vectors: readonly (readonly number[])[],
  k: number,
  meta: { provider: EmbeddingProviderName; model: string },
): AnisotropyCalibration {
  if (vectors.length === 0) {
    throw new Error("fitAnisotropyCalibration: no vectors supplied");
  }
  if (k < 1 || !Number.isInteger(k)) {
    throw new Error(
      `fitAnisotropyCalibration: k must be a positive integer, got ${k}`,
    );
  }
  const dim = vectors[0].length;
  if (dim === 0) {
    throw new Error("fitAnisotropyCalibration: vectors are zero-dimensional");
  }
  for (let i = 1; i < vectors.length; i++) {
    if (vectors[i].length !== dim) {
      throw new Error(
        `fitAnisotropyCalibration: vector ${i} has dim ${vectors[i].length}, expected ${dim}`,
      );
    }
  }
  if (k > dim) {
    throw new Error(
      `fitAnisotropyCalibration: requested k=${k} exceeds embedding dim=${dim}`,
    );
  }

  const n = vectors.length;
  // Flatten into a contiguous Float64Array for cache locality during the
  // O(k · iter · n · d) inner loop. Centre each row in place against the
  // running mean once it's computed.
  const data = new Float64Array(n * dim);
  for (let i = 0; i < n; i++) {
    const row = vectors[i];
    for (let j = 0; j < dim; j++) {
      data[i * dim + j] = row[j];
    }
  }

  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      mean[j] += data[base + j];
    }
  }
  for (let j = 0; j < dim; j++) {
    mean[j] /= n;
  }

  // Centre rows in place. After this `data` represents X = X_raw - mean.
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      data[base + j] -= mean[j];
    }
  }

  // Total variance: tr(X^T X) / (n - 1) = Σ_i ‖x_i‖² / (n - 1).
  // Use n-1 for sample variance; falls back to 1 when n === 1 to avoid div0.
  const denom = Math.max(1, n - 1);
  let totalVariance = 0;
  for (let i = 0; i < n * dim; i++) {
    totalVariance += data[i] * data[i];
  }
  totalVariance /= denom;

  const components: Float64Array[] = [];
  const componentVariance: number[] = [];
  for (let pcIdx = 0; pcIdx < k; pcIdx++) {
    const v = powerIteration(data, n, dim, components);
    // Eigenvalue λ = ‖X v‖² / (n - 1).
    const Xv = matmulXv(data, n, dim, v);
    let xvSq = 0;
    for (let i = 0; i < n; i++) xvSq += Xv[i] * Xv[i];
    components.push(v);
    componentVariance.push(xvSq / denom);
  }

  return {
    provider: meta.provider,
    model: meta.model,
    dim,
    mean: Array.from(mean),
    components: components.map((c) => Array.from(c)),
    componentVariance,
    totalVariance,
    sampleCount: n,
    fitAt: Date.now(),
  };
}

/**
 * Apply the all-but-the-top correction to a single embedding vector.
 *
 * The input is L2-normalised first so callers don't have to think about
 * whether the source already lives on the unit sphere (Qdrant pre-normalises
 * stored vectors under cosine distance; Gemini's API does not). The result
 * is L2-normalised again so cosine similarity continues to behave like a
 * dot product.
 *
 * Returns a fresh `number[]`; never mutates `vec` or the calibration.
 */
export function applyAnisotropyCorrection(
  vec: readonly number[],
  calib: AnisotropyCalibration,
): number[] {
  if (vec.length !== calib.dim) {
    throw new Error(
      `applyAnisotropyCorrection: vec dim ${vec.length} != calibration dim ${calib.dim}`,
    );
  }

  const out = new Float64Array(calib.dim);
  for (let j = 0; j < calib.dim; j++) out[j] = vec[j];
  l2NormalizeInPlace(out);

  for (let j = 0; j < calib.dim; j++) {
    out[j] -= calib.mean[j];
  }

  for (const pc of calib.components) {
    let proj = 0;
    for (let j = 0; j < calib.dim; j++) proj += out[j] * pc[j];
    for (let j = 0; j < calib.dim; j++) out[j] -= proj * pc[j];
  }

  l2NormalizeInPlace(out);
  return Array.from(out);
}

/**
 * Compute the explained-variance ratio for each component. The list is
 * monotonically non-increasing because power iteration with deflation pulls
 * the largest eigenvalue first.
 */
export function explainedVarianceRatio(calib: AnisotropyCalibration): number[] {
  if (calib.totalVariance === 0) {
    return calib.componentVariance.map(() => 0);
  }
  return calib.componentVariance.map((v) => v / calib.totalVariance);
}

// ── Persistence ──────────────────────────────────────────────────────────────

const cache = new Map<string, AnisotropyCalibration | null>();

function calibrationKey(
  provider: EmbeddingProviderName,
  model: string,
  dim: number,
): string {
  return `${provider}:${model}:${dim}`;
}

function calibrationPath(
  provider: EmbeddingProviderName,
  model: string,
  dim: number,
): string {
  // Models can contain slashes (`gemini-embedding-2`, `text-embedding-3-large`,
  // `BAAI/bge-base-en-v1.5`). Replace anything that's not filename-safe with
  // `_` so the on-disk name is portable across platforms.
  const safeModel = model.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(
    getDataDir(),
    "anisotropy",
    `${provider}-${safeModel}-${dim}.json`,
  );
}

/**
 * Convenience: load the calibration and apply it to a vector in one call.
 * Returns the input untouched when no calibration has been persisted for the
 * (provider, model, dim) tuple. The intended call site is right at the
 * boundary between the embedding backend and consumers that store/query
 * vectors against Qdrant — write paths apply this before upsert, read paths
 * apply it before search.
 */
export async function applyCorrectionIfCalibrated(
  vec: number[],
  provider: EmbeddingProviderName,
  model: string,
): Promise<number[]> {
  const calib = await loadCalibration(provider, model, vec.length);
  if (!calib) return vec;
  return applyAnisotropyCorrection(vec, calib);
}

/**
 * Load the calibration for a (provider, model, dim) tuple. Returns `null`
 * when no fit has been persisted yet — callers should treat this as
 * "anisotropy correction is off for this embedder" and pass through raw
 * vectors. Module-level cached so subsequent calls hit memory.
 */
export async function loadCalibration(
  provider: EmbeddingProviderName,
  model: string,
  dim: number,
): Promise<AnisotropyCalibration | null> {
  const key = calibrationKey(provider, model, dim);
  if (cache.has(key)) return cache.get(key) ?? null;

  const path = calibrationPath(provider, model, dim);
  if (!existsSync(path)) {
    cache.set(key, null);
    return null;
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as AnisotropyCalibration;
    cache.set(key, parsed);
    return parsed;
  } catch {
    // A corrupt file is treated the same as a missing one: pass-through.
    // The fit path will overwrite with a valid file on the next run.
    cache.set(key, null);
    return null;
  }
}

/**
 * Persist a calibration to disk and refresh the in-process cache so the
 * next `loadCalibration` returns the new fit without a file read.
 */
export async function saveCalibration(
  calib: AnisotropyCalibration,
): Promise<string> {
  const path = calibrationPath(calib.provider, calib.model, calib.dim);
  await mkdir(join(getDataDir(), "anisotropy"), { recursive: true });
  await writeFile(path, JSON.stringify(calib), "utf8");
  cache.set(calibrationKey(calib.provider, calib.model, calib.dim), calib);
  return path;
}

/** @internal Test-only: drop the in-process calibration cache. */
export function clearAnisotropyCacheForTests(): void {
  cache.clear();
}

// ── Power iteration internals ────────────────────────────────────────────────

const POWER_ITERATION_MAX = 200;
const POWER_ITERATION_TOL = 1e-7;

/**
 * Find the dominant eigenvector of X^T X (with previously-found components
 * deflated out) via power iteration. Operates on `X v` and `X^T u` separately
 * so we never materialise the d×d covariance matrix — for d=3072 that would
 * be ~75 MB and cripple memory locality. Returns a unit-length d-vector.
 */
function powerIteration(
  data: Float64Array,
  n: number,
  dim: number,
  deflate: readonly Float64Array[],
): Float64Array {
  // Deterministic init: a fixed unit vector. Power iteration converges from
  // any non-orthogonal start, and a deterministic seed keeps fit results
  // reproducible across runs (helpful for debugging and tests).
  const v = new Float64Array(dim);
  v[0] = 1;
  // Project off any previously-found components from the init too, so we
  // don't waste iterations re-deflating the same direction every step.
  deflateInPlace(v, deflate);
  l2NormalizeInPlace(v);

  let prevDot = 0;
  for (let iter = 0; iter < POWER_ITERATION_MAX; iter++) {
    const Xv = matmulXv(data, n, dim, v);
    const next = matmulXTu(data, n, dim, Xv);
    deflateInPlace(next, deflate);
    const norm = l2NormalizeInPlace(next);
    if (norm === 0) {
      // The remaining variance lives entirely in the deflated subspace —
      // every direction we can pick is orthogonal to the data. Returning the
      // current best estimate keeps the spectrum monotonic instead of
      // emitting NaN downstream.
      return v;
    }
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += v[j] * next[j];
    // |dot| approaches 1 as power iteration converges (sign can flip across
    // iterations, so absolute value).
    if (Math.abs(Math.abs(dot) - Math.abs(prevDot)) < POWER_ITERATION_TOL) {
      return next;
    }
    prevDot = dot;
    for (let j = 0; j < dim; j++) v[j] = next[j];
  }
  return v;
}

/** y = X v, where X is n×d row-major. Returns a fresh Float64Array of length n. */
function matmulXv(
  data: Float64Array,
  n: number,
  dim: number,
  v: Float64Array,
): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let acc = 0;
    for (let j = 0; j < dim; j++) acc += data[base + j] * v[j];
    out[i] = acc;
  }
  return out;
}

/** y = X^T u, where X is n×d row-major. Returns a fresh Float64Array of length d. */
function matmulXTu(
  data: Float64Array,
  n: number,
  dim: number,
  u: Float64Array,
): Float64Array {
  const out = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    const ui = u[i];
    for (let j = 0; j < dim; j++) out[j] += data[base + j] * ui;
  }
  return out;
}

/** Subtract every previously-found component from `v` (Gram-Schmidt). */
function deflateInPlace(
  v: Float64Array,
  deflate: readonly Float64Array[],
): void {
  for (const pc of deflate) {
    let proj = 0;
    const dim = v.length;
    for (let j = 0; j < dim; j++) proj += v[j] * pc[j];
    for (let j = 0; j < dim; j++) v[j] -= proj * pc[j];
  }
}

/** L2-normalise `v` in place. Returns the original norm so callers can detect zero vectors. */
function l2NormalizeInPlace(v: Float64Array): number {
  let norm = 0;
  for (let j = 0; j < v.length; j++) norm += v[j] * v[j];
  norm = Math.sqrt(norm);
  if (norm === 0) return 0;
  const inv = 1 / norm;
  for (let j = 0; j < v.length; j++) v[j] *= inv;
  return norm;
}
