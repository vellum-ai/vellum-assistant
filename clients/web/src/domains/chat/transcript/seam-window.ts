/**
 * The seam window: a short buffer of stream events that have arrived but are
 * not yet folded into the history base, holding them keyed by `seq` so the base
 * only ever absorbs a gap-free, in-order prefix. `ingest` buffers an event
 * (dropping duplicates and ones already folded), `compact` folds the contiguous
 * prefix into the base via `applyEvent`, and a non-empty remainder marks a gap
 * the base must wait on.
 */

import { applyEvent } from "@/domains/chat/transcript/rolling-base";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

/** Buffered-but-unfolded events, keyed by global `seq`. */
export type SeamWindow = ReadonlyMap<number, AssistantEventEnvelope>;

export const emptySeamWindow: SeamWindow = new Map();

/**
 * Buffer an event for later compaction. An event with no `seq` can't be
 * ordered or deduped and is left to the caller; one at or below the base's
 * `seq` is already folded, and one already buffered is a duplicate — both are
 * dropped (the window is returned unchanged). Otherwise the event is inserted
 * keyed by its `seq`.
 */
export function ingest(
  window: SeamWindow,
  baseSeq: number | null | undefined,
  envelope: AssistantEventEnvelope,
): SeamWindow {
  const { seq } = envelope;
  if (typeof seq !== "number") return window;
  if (typeof baseSeq === "number" && seq <= baseSeq) return window;
  if (window.has(seq)) return window;
  const next = new Map(window);
  next.set(seq, envelope);
  return next;
}

/**
 * Fold the gap-free prefix of the window into the base. Starting at
 * `base.seq + 1`, each consecutive buffered event is applied and removed; the
 * walk stops at the first missing `seq`, so a hole parks the rest of the window
 * until it is backfilled. A base with no `seq` has no version anchor to fold
 * from — the window is held until a snapshot seeds one — so this is a no-op.
 * Returns the same references when nothing folds.
 */
export function compact(
  base: PaginatedHistoryResult,
  window: SeamWindow,
): { base: PaginatedHistoryResult; window: SeamWindow } {
  if (typeof base.seq !== "number") return { base, window };
  let expected = base.seq + 1;
  if (!window.has(expected)) return { base, window };

  const remaining = new Map(window);
  let folded = base;
  while (remaining.has(expected)) {
    folded = applyEvent(folded, remaining.get(expected)!);
    remaining.delete(expected);
    expected += 1;
  }
  return { base: folded, window: remaining };
}

/**
 * The gap between what the base has folded and the earliest buffered event, or
 * `null` when the window is empty, contiguous with the base, or has no version
 * anchor to measure against. `expected` is the next `seq` the base needs;
 * `have` is the earliest one buffered — the daemon can replay `(expected, have)`
 * to close it. Most useful after `compact`, when any remainder sits past a gap.
 */
export function firstGap(
  base: PaginatedHistoryResult,
  window: SeamWindow,
): { expected: number; have: number } | null {
  if (window.size === 0 || typeof base.seq !== "number") return null;
  let have = Infinity;
  for (const seq of window.keys()) have = Math.min(have, seq);
  const expected = base.seq + 1;
  return have > expected ? { expected, have } : null;
}
