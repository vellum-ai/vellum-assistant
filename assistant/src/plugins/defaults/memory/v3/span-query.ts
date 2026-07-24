/**
 * Memory v3 — deterministic clause chunking for the span-query dense pass.
 *
 * A single embedding of a long, multi-topic message averages its distinct
 * retrieval intents into one vector that matches none of them — the
 * within-message form of the cross-speaker averaging the reply-query pass
 * exists to avoid. The span pass re-runs the dense lane over the message's
 * clause spans as separate queries so a motif buried in one clause retrieves
 * at full strength.
 *
 * Chunking is pure text processing: split at newlines and sentence
 * punctuation, drop sub-{@link MIN_SPAN_CHARS} fragments. A message yielding
 * more than {@link MAX_SPAN_CHUNKS} spans is NOT truncated to its head — all
 * spans are partitioned into {@link MAX_SPAN_CHUNKS} contiguous near-equal
 * groups, so the whole message stays covered and long messages are simply
 * queried at paragraph grain instead of clause grain.
 */

/** Hard cap on span chunks per message — bounds the pass at
 *  `MAX_SPAN_CHUNKS × spanQueryK` extra candidates and as many embed calls. */
export const MAX_SPAN_CHUNKS = 8;

/** Spans shorter than this carry no retrieval signal ("ok.", bare emoji
 *  lines) and are dropped before chunking. */
const MIN_SPAN_CHARS = 15;

/**
 * Split `message` into at most {@link MAX_SPAN_CHUNKS} contiguous clause
 * chunks. Messages with that many spans or fewer return them unchanged;
 * longer messages merge adjacent spans into near-equal groups covering the
 * whole message. Deterministic; returns `[]` for empty/whitespace input.
 */
export function spanChunksOf(message: string): string[] {
  const spans = message
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SPAN_CHARS);
  if (spans.length <= MAX_SPAN_CHUNKS) {
    return spans;
  }
  const chunks: string[] = [];
  for (let i = 0; i < MAX_SPAN_CHUNKS; i++) {
    const lo = Math.floor((i * spans.length) / MAX_SPAN_CHUNKS);
    const hi = Math.floor(((i + 1) * spans.length) / MAX_SPAN_CHUNKS);
    if (hi > lo) {
      chunks.push(spans.slice(lo, hi).join(" "));
    }
  }
  return chunks;
}
