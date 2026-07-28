/**
 * Shared types for the memory comparison harness, referenced by both the
 * retriever seam (`retriever.ts`) and the descent tracing (`trace.ts`).
 */

/** Optional cost accounting for a single retrieval. */
export interface RetrievalCost {
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  ms?: number;
}
