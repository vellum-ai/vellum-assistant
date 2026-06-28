// ---------------------------------------------------------------------------
// Sparse-vector tokenization primitives
// ---------------------------------------------------------------------------
//
// Shared by both the legacy TF-only encoder in `embedding-backend.ts`
// (`generateSparseEmbedding`) and the BM25 encoder in `v2/sparse-bm25.ts`.
//
// Lives in its own module so consumers of the BM25 encoder don't transitively
// depend on `embedding-backend.ts` for these primitives — that matters
// because many tests mock `embedding-backend.js` wholesale via
// `mock.module(...)`, and a missing export from the mock would break any
// transitive importer of these helpers.

import { stemmer } from "stemmer";

/** Hashed-vocabulary size for sparse encoders. */
export const SPARSE_VOCAB_SIZE = 30_000;

/** Tokenize text into lowercase alphanumeric tokens (Unicode-aware). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Tokenize and apply Porter stemming so morphological variants collapse to a
 * shared bucket (e.g. `running`/`runs`/`ran` → `run`, `supplements` →
 * `supplement`). Used only by the BM25 sparse channel in
 * `v2/sparse-bm25.ts`; both the document-side and query-side encoders call
 * this so doc and query tokens land in the same hash buckets.
 *
 * Other callers (workspace context-search, the legacy TF-only
 * `generateSparseEmbedding`) intentionally keep the non-stemmed `tokenize()`
 * because they predate this and rebuilding their on-disk indexes is out of
 * scope here.
 */
export function tokenizeStemmed(text: string): string[] {
  return tokenize(text).map((token) => stemmer(token));
}

/** Hash a token to a stable index in [0, vocabSize). */
export function tokenHash(token: string, vocabSize: number): number {
  // FNV-1a 32-bit hash for speed
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % vocabSize;
}
