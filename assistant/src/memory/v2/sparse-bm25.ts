// ---------------------------------------------------------------------------
// Memory v2 — BM25 sparse channel
// ---------------------------------------------------------------------------
//
// Replaces the legacy TF-only sparse embedding (`generateSparseEmbedding` in
// `../embedding-backend.ts`) with a real Okapi BM25 implementation. Common
// words like "i", "am", "the" no longer dominate sparse matching the way they
// did when every token was weighted equally.
//
// BM25 score for document `d` and query `q`:
//
//   score(d, q) = Σ_t∈q  IDF(t) · TF_sat(d, t)
//   TF_sat(d, t) = tf(d, t) · (k1 + 1)
//                / (tf(d, t) + k1 · (1 - b + b · |d| / avg_dl))
//   IDF(t)       = log( (N - df(t) + 0.5) / (df(t) + 0.5) + 1 )
//
// `+1` inside the IDF log keeps the result non-negative even when df(t) > N/2,
// matching the variant Lucene uses for `BM25Similarity`.
//
// **Asymmetric encoding**: documents carry the full BM25 weight per token
// (IDF · TF_sat baked into the stored vector), and queries carry binary
// occurrence per token. Qdrant's sparse dot product then reduces to the BM25
// score directly. Putting BM25 on the doc side means the weights need
// recomputing whenever the corpus DF or avg_dl changes — operators trigger
// that with `assistant memory v2 reembed` after major content shifts.

import { readFile } from "node:fs/promises";

import type { SparseEmbedding } from "../embedding-types.js";
import {
  SPARSE_VOCAB_SIZE,
  tokenHash,
  tokenizeStemmed,
} from "../sparse-tokenize.js";
import { listPages } from "./page-store.js";

/**
 * Aggregate corpus statistics used to weight a BM25 document vector. Held in
 * memory after a startup walk over `memory/concepts/`.
 */
export interface CorpusStats {
  /** Total document count over which DF was accumulated. */
  totalDocs: number;
  /** hashedTokenIndex (in `[0, SPARSE_VOCAB_SIZE)`) → distinct-doc count. */
  df: Map<number, number>;
  /** Average document length in tokens, post-tokenize. */
  avgDl: number;
  /** Wall-clock millis at build time — used by diagnostics, not the formula. */
  builtAt: number;
}

/** BM25 hyperparameters. Standard Lucene/Elasticsearch defaults. */
export interface Bm25Params {
  /** TF saturation curve. ~1.2 is standard. */
  k1: number;
  /** Length normalization. 0 = none, 1 = full. ~0.75 is standard. */
  b: number;
}

let _conceptPageStats: CorpusStats | null = null;

/**
 * Latest in-memory corpus stats for `memory/concepts/`, or `null` if a build
 * has not yet completed. Callers must handle `null` and fall back to legacy
 * TF-only behavior so the daemon remains usable during the brief startup
 * window before {@link rebuildConceptPageCorpusStats} finishes.
 */
export function getConceptPageCorpusStats(): CorpusStats | null {
  return _conceptPageStats;
}

/**
 * Walk every concept page on disk, accumulate document frequency per hashed
 * token bucket, and average document length. Atomically swaps the result into
 * the module-level cache when the walk succeeds. On error the previous stats
 * stay live.
 *
 * Reads bodies via `readPage`-equivalent direct file reads to avoid paying for
 * frontmatter parsing on every page (we only need the body for sparse).
 */
export async function rebuildConceptPageCorpusStats(
  workspaceDir: string,
): Promise<void> {
  const slugs = await listPages(workspaceDir);
  if (slugs.length === 0) {
    _conceptPageStats = {
      totalDocs: 0,
      df: new Map(),
      avgDl: 0,
      builtAt: Date.now(),
    };
    return;
  }

  const df = new Map<number, number>();
  let totalTokens = 0;
  let docsCounted = 0;

  for (const slug of slugs) {
    const body = await readPageBodyForStats(workspaceDir, slug);
    if (body === null) continue;
    const tokens = tokenizeStemmed(body);
    if (tokens.length === 0) continue;
    totalTokens += tokens.length;
    docsCounted += 1;
    const seen = new Set<number>();
    for (const token of tokens) {
      const idx = tokenHash(token, SPARSE_VOCAB_SIZE);
      if (seen.has(idx)) continue;
      seen.add(idx);
      df.set(idx, (df.get(idx) ?? 0) + 1);
    }
  }

  _conceptPageStats = {
    totalDocs: docsCounted,
    df,
    avgDl: docsCounted > 0 ? totalTokens / docsCounted : 0,
    builtAt: Date.now(),
  };
}

/**
 * Read just the body of a page for stats accumulation. Skips the YAML
 * frontmatter without invoking the schema-validating `readPage` parser, since
 * any parse failure surfaced there would abort the whole rebuild — and we
 * only need the prose half for tokenization.
 */
async function readPageBodyForStats(
  workspaceDir: string,
  slug: string,
): Promise<string | null> {
  const path = `${workspaceDir}/memory/concepts/${slug}.md`;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  // Strip a leading `---\n...\n---\n` block if present; otherwise return raw.
  if (raw.startsWith("---")) {
    const closing = raw.indexOf("\n---", 3);
    if (closing !== -1) {
      const after = raw.indexOf("\n", closing + 4);
      if (after !== -1) return raw.slice(after + 1);
    }
  }
  return raw;
}

/**
 * Compute the BM25 IDF weight for a hashed token bucket. Returns `0` when the
 * token's df equals the corpus size (a token in every document carries no
 * discriminating power).
 */
function computeIdf(stats: CorpusStats, hashIdx: number): number {
  const df = stats.df.get(hashIdx) ?? 0;
  const numerator = stats.totalDocs - df + 0.5;
  const denominator = df + 0.5;
  return Math.log(numerator / denominator + 1);
}

/**
 * Document-side BM25-weighted sparse vector. Each emitted value is
 * `IDF(t) · TF_sat(d, t)` so the dot product against a binary query vector
 * (see {@link generateBm25QueryEmbedding}) yields the BM25 score.
 *
 * Returns an empty embedding for empty input or when the corpus is empty
 * (every IDF would be zero anyway).
 */
export function generateBm25DocEmbedding(
  text: string,
  stats: CorpusStats,
  params: Bm25Params,
): SparseEmbedding {
  const tokens = tokenizeStemmed(text);
  if (tokens.length === 0 || stats.totalDocs === 0) {
    return { indices: [], values: [] };
  }

  // Per-document term frequencies, keyed by hashed bucket.
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = tokenHash(token, SPARSE_VOCAB_SIZE);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  const docLen = tokens.length;
  // avg_dl can be 0 only when totalDocs is 0, which we already short-circuited.
  const lengthFactor = 1 - params.b + (params.b * docLen) / stats.avgDl;
  const indices: number[] = [];
  const values: number[] = [];

  for (const [idx, freq] of tf) {
    const idf = computeIdf(stats, idx);
    if (idf === 0) continue; // Skip tokens that contribute nothing to scores.
    const saturated =
      (freq * (params.k1 + 1)) / (freq + params.k1 * lengthFactor);
    const weight = idf * saturated;
    if (weight === 0) continue;
    indices.push(idx);
    values.push(weight);
  }

  return { indices, values };
}

/**
 * Query-side sparse vector — binary occurrence per distinct query token. The
 * dot product `Σ_t v_q(t) · v_d(t)` against a BM25-weighted document vector
 * is exactly the BM25 score, since `v_q(t) = 1` for tokens in the query and
 * `0` otherwise.
 *
 * Stateless — does not need corpus stats, so callers can use this on every
 * turn without coordinating with {@link rebuildConceptPageCorpusStats}.
 */
export function generateBm25QueryEmbedding(text: string): SparseEmbedding {
  const tokens = tokenizeStemmed(text);
  if (tokens.length === 0) {
    return { indices: [], values: [] };
  }

  const seen = new Set<number>();
  const indices: number[] = [];
  const values: number[] = [];
  for (const token of tokens) {
    const idx = tokenHash(token, SPARSE_VOCAB_SIZE);
    if (seen.has(idx)) continue;
    seen.add(idx);
    indices.push(idx);
    values.push(1);
  }

  return { indices, values };
}

/** @internal Test-only: reset module-level singletons. */
export function _resetCorpusStatsForTests(): void {
  _conceptPageStats = null;
}

/** @internal Test-only: install a fixture stats table without disk I/O. */
export function _setCorpusStatsForTests(stats: CorpusStats | null): void {
  _conceptPageStats = stats;
}
