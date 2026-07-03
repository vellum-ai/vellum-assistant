/**
 * Shared diff classification for the two incremental subagent projectors
 * (`subagent-step-projection.ts` and `subagent-detail-projection.ts`).
 *
 * Both projectors face the IDENTICAL problem: classify the diff between the
 * previous `events` array and the new one into one of the store's known
 * mutation shapes, then replay only the changed events through their own
 * reducer. The classification guards are subtle (especially the cross-subagent
 * `detail-1` id-collision guard), so they live here ONCE — extracting them
 * prevents the two copies from drifting apart.
 *
 * Background — the store mutates `entry.events` in exactly three shapes
 * (verified in `subagent-store.ts` `receiveEvent` / `loadDetail`):
 *
 *  1. **Append-1** — a new `tool_call` / `tool_result` / `error` / first `text`
 *     event lands → `events: [...existing.events, ev]`. A new array, but every
 *     prior element keeps its reference and exactly one element is appended at
 *     the tail.
 *  2. **Mutate-last** — consecutive `assistant_text_delta`s coalesce → the array
 *     is copied (`[...existing.events]`) with only the **last** element replaced
 *     by `{ ...lastEvent, content: lastEvent.content + delta }`. Same length,
 *     same element references except the last, the last keeps the **same `id`**,
 *     and its `content` only grows. Always a `text` event. We classify this shape
 *     by the text-coalescing CONTENT shape — both last events `type: "text"` and
 *     the new content strictly EXTENDS the old (`startsWith` + non-shrinking
 *     length) — not just last-id equality. `mapDetailEvents` restarts ids at
 *     `detail-1` per subagent, so two different subagents whose detail arrays each
 *     have one event collide on `id === "detail-1"`; matching only by id would
 *     misclassify a subagent switch as mutate-last and leave a stale step/entry
 *     that a full rebuild drops (then a stale pill/key could open the previous
 *     subagent's detail).
 *  3. **Full-replace** — `loadDetail` swaps the whole array (history hydration /
 *     subagent switch).
 *
 * Any diff that doesn't fit the append / mutate-last shapes (full-replace,
 * truncation, reorder, or a violated assumption) is classified `fallback`, which
 * the projectors handle with a full O(n) rebuild that is always correct.
 */

import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

/**
 * The classification of a diff between `prevEvents` and `events`.
 *
 * - `identity` — same array reference; nothing changed.
 * - `first` — no previous array (first call / empty cache); build from scratch.
 * - `append` — same prefix, one-or-more new events at the tail. `from` is the
 *   index to start replaying the appended events (i.e. `prevEvents.length`).
 * - `mutate-last` — text-delta coalescing: same length, only the last element
 *   replaced by a strict content extension, every earlier element shared.
 * - `fallback` — full-replace / truncation / reorder / violated assumption.
 */
export type EventsDiff =
  | { kind: "identity" }
  | { kind: "first" }
  | { kind: "append"; from: number }
  | { kind: "mutate-last" }
  | { kind: "fallback" };

/**
 * Classify the diff between the previous `events` array and the new one into one
 * of the store's known mutation shapes. Pure and O(1) — only reference and
 * tail-content checks, no walk of the arrays.
 */
export function classifyEventsDiff(
  prevEvents: SubagentTimelineEvent[] | null,
  events: SubagentTimelineEvent[],
): EventsDiff {
  // Identity — also covers events-stable status/usage updates (the entry object
  // changes but its events array reference does not).
  if (events === prevEvents) return { kind: "identity" };

  // First call / empty cache.
  if (prevEvents == null) return { kind: "first" };

  const prevLen = prevEvents.length;
  const len = events.length;

  // Append: same prefix, one-or-more new events at the tail. The O(1)
  // boundary checks (first + last-of-prev still share their references)
  // distinguish a genuine append from a full-replace whose new array happens
  // to be longer.
  if (
    len > prevLen &&
    (prevLen === 0 ||
      (events[0] === prevEvents[0] &&
        events[prevLen - 1] === prevEvents[prevLen - 1]))
  ) {
    return { kind: "append", from: prevLen };
  }

  // Mutate-last: text-delta coalescing. Same length, only the last element
  // replaced, every earlier element shared. We require the genuine
  // text-coalescing CONTENT shape the store actually produces, NOT just last-id
  // equality: both last events must be `type: "text"` and the new content must
  // strictly EXTEND the old (`content: lastEvent.content + delta`). Id equality
  // alone is insufficient because `mapDetailEvents` restarts event ids at
  // `detail-1` per subagent — a single-event subagent switch collides on
  // `id === "detail-1"` and would be misclassified, surviving a stale step/entry.
  // The type + content-extension guards reject that collision (different type, or
  // content that isn't a strict extension → Fallback full rebuild).
  if (
    len === prevLen &&
    len >= 1 &&
    events[len - 1] !== prevEvents[len - 1] &&
    events[len - 1]!.id === prevEvents[len - 1]!.id &&
    prevEvents[len - 1]!.type === "text" &&
    events[len - 1]!.type === "text" &&
    events[len - 1]!.content.length >= prevEvents[len - 1]!.content.length &&
    events[len - 1]!.content.startsWith(prevEvents[len - 1]!.content) &&
    (len === 1 || events[len - 2] === prevEvents[len - 2])
  ) {
    return { kind: "mutate-last" };
  }

  // Fallback — full-replace / truncation / reorder / violated assumption.
  return { kind: "fallback" };
}
