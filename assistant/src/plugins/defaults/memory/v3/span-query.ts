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
 * punctuation, drop fragments below {@link MIN_SPAN_WEIGHT}. A message yielding
 * more than {@link MAX_SPAN_CHUNKS} spans is NOT truncated to its head — all
 * spans are partitioned into {@link MAX_SPAN_CHUNKS} contiguous near-equal
 * groups, so the whole message stays covered and long messages are simply
 * queried at paragraph grain instead of clause grain.
 */

/** Hard cap on span chunks per message — bounds the pass at
 *  `MAX_SPAN_CHUNKS × spanQueryK` extra candidates and as many embed calls. */
export const MAX_SPAN_CHUNKS = 8;

/** Spans weighing less than this carry no retrieval signal ("ok.", bare emoji
 *  lines) and are dropped before chunking. Weight, not raw length — see
 *  {@link spanWeight}. */
const MIN_SPAN_WEIGHT = 15;

/** Dense CJK scripts pack roughly a clause into the character budget English
 *  needs for a few words, so a raw char floor tuned for spaced scripts would
 *  drop nearly every realistic Chinese/Japanese/Korean sentence. Weigh those
 *  chars at 3× so the floor measures comparable information content. */
const DENSE_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

function spanWeight(span: string): number {
  let weight = 0;
  for (const ch of span) {
    weight += DENSE_SCRIPT.test(ch) ? 3 : 1;
  }
  return weight;
}

/**
 * Split `message` into at most {@link MAX_SPAN_CHUNKS} contiguous clause
 * chunks. Messages with that many spans or fewer return them unchanged;
 * longer messages merge adjacent spans into near-equal groups covering the
 * whole message. Deterministic; returns `[]` for empty/whitespace input.
 */
export function spanChunksOf(message: string): string[] {
  // Boundaries: newlines; any Unicode sentence terminator (`\p{STerm}` covers
  // ASCII `.!?` plus CJK `。！？`, Arabic `؟`, Devanagari `।`, …) or ellipsis
  // followed by whitespace; and a zero-width split after fullwidth CJK
  // terminators, which conventionally have NO trailing space. The whitespace
  // requirement on the general arm keeps ASCII `.` from splitting decimals
  // and dotted abbreviations; fullwidth terminators never appear there.
  const spans = message
    .split(/\n+|(?<=[\p{STerm}…])\s+|(?<=[。！？｡])/u)
    .map((s) => s.trim())
    .filter((s) => spanWeight(s) >= MIN_SPAN_WEIGHT);
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
