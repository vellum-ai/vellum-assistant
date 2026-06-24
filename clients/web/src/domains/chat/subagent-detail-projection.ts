/**
 * Incremental nested-detail projection for a subagent's timeline.
 *
 * The detail-map counterpart to `subagent-step-projection.ts`: the same store
 * mutates `entry.events` in exactly three shapes (verified in
 * `subagent-store.ts` `receiveEvent` / `loadDetail`):
 *
 *  1. **Append-1** — a new `tool_call` / `tool_result` / `error` / first `text`
 *     event lands → `events: [...existing.events, ev]`. Every prior element
 *     keeps its reference; exactly one element is appended at the tail.
 *  2. **Mutate-last** — consecutive `assistant_text_delta`s coalesce → the array
 *     is copied with only the **last** element replaced by
 *     `{ ...lastEvent, content: lastEvent.content + delta }`. Same length, same
 *     element references except the last, same `id` on the last, growing
 *     `content`. Always a `text` event. We classify this shape by the
 *     text-coalescing CONTENT shape — both last events `type: "text"` and the
 *     new content strictly EXTENDS the old (`startsWith` + non-shrinking length)
 *     — not just last-id equality. `mapDetailEvents` restarts ids at `detail-1`
 *     per subagent, so two different subagents whose detail arrays each have one
 *     event collide on `id === "detail-1"`; matching only by id would misclassify
 *     a subagent switch as mutate-last and leave a stale tool entry that a full
 *     rebuild drops (then a stale pill could open the previous subagent's detail).
 *  3. **Full-replace** — `loadDetail` swaps the whole array (history hydration /
 *     subagent switch).
 *
 * `buildSubagentStepDetails(events)` is O(n); running it on every streamed event
 * would be O(n²) over a run. This projector replays only the
 * events that changed since the last call, folding them through the **same**
 * `applyDetailEvent` reducer the full rebuild uses — so the incremental and full
 * paths can never drift. Any diff that doesn't fit the append / mutate-last
 * shapes (full-replace, truncation, reorder, or a violated assumption) falls
 * back to a full O(n) `buildSubagentStepDetails` rebuild, which is always
 * correct.
 *
 * NOTE — unlike the step projection, this map is consumed **lazily**: the panel
 * only reads from it when a timeline pill is clicked. Its churn therefore never
 * drives a render on its own, so there is no identity-preservation shortcut to
 * be had here (and the mutate-last `thinkingText` carries the FULL untruncated
 * content, which changes on every delta anyway). The win is purely avoiding the
 * O(n) re-walk per streamed event — replaying only the changed events — not
 * re-render avoidance.
 */

import { useRef } from "react";

import { applyDetailEvent } from "@/domains/chat/hooks/use-subagent-card-data";
import { classifyEventsDiff } from "@/domains/chat/subagent-projection-diff";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/** Per-payload metadata tracked in parallel with `payloads` (indexed by position). */
type DetailMeta = { startTs: number; running: boolean };

/** The per-event reducer signature shared by the full and incremental paths. */
type DetailReducer = (
  payloads: ToolDetailPayload[],
  meta: DetailMeta[],
  event: SubagentTimelineEvent,
) => void;

/** Build the keyed `Map` from the payload array exactly as `buildSubagentStepDetails` does. */
function payloadsToMap(
  payloads: ToolDetailPayload[],
): Map<string, ToolDetailPayload> {
  return new Map(payloads.map((payload) => [payload.toolCallId, payload]));
}

/**
 * Create a stateful incremental detail projector. `project(events)` returns the
 * `toolCallId`-keyed `Map<string, ToolDetailPayload>` for `events`, replaying
 * only the diff vs the previous call through `applyDetailEvent`. The payload
 * array, parallel meta array, and resulting `Map` are cached; identical inputs
 * return the cached `Map` by reference.
 *
 * One projector instance owns one cache slot — hold it per component instance
 * (see `useSubagentStepDetails`), never module-global, so the panel and any
 * other consumer don't thrash a single slot.
 *
 * `reducer` defaults to the real `applyDetailEvent`; it's a seam for the
 * incremental-work guard test to count reducer invocations without mocking.
 */
export function createIncrementalDetailProjection(
  reducer: DetailReducer = applyDetailEvent,
) {
  let prevEvents: SubagentTimelineEvent[] | null = null;
  let payloads: ToolDetailPayload[] = [];
  let meta: DetailMeta[] = [];
  let map: Map<string, ToolDetailPayload> = new Map();

  function fullBuild(
    events: SubagentTimelineEvent[],
  ): Map<string, ToolDetailPayload> {
    // Re-run the reducer ourselves (rather than calling `buildSubagentStepDetails`)
    // so the cached `payloads`/`meta` stay in sync for the next incremental diff.
    const builtPayloads: ToolDetailPayload[] = [];
    const builtMeta: DetailMeta[] = [];
    for (const event of events) reducer(builtPayloads, builtMeta, event);

    prevEvents = events;
    payloads = builtPayloads;
    meta = builtMeta;
    map = payloadsToMap(payloads);
    return map;
  }

  function project(
    events: SubagentTimelineEvent[],
  ): Map<string, ToolDetailPayload> {
    // The diff classification (including the subtle cross-subagent `detail-1`
    // id-collision guard) is shared with the step projector — see
    // `subagent-projection-diff.ts`.
    const diff = classifyEventsDiff(prevEvents, events);

    switch (diff.kind) {
      // Identity — also covers events-stable status/usage updates.
      case "identity":
        return map;

      // First call / empty cache.
      case "first":
        return fullBuild(events);

      // Append: same prefix, one-or-more new events at the tail. Replay only
      // the appended events through the reducer.
      case "append": {
        const len = events.length;
        const payloadsClone = payloads.slice();
        const metaClone = meta.slice();
        for (let i = diff.from; i < len; i++) {
          reducer(payloadsClone, metaClone, events[i]!);
        }
        prevEvents = events;
        payloads = payloadsClone;
        meta = metaClone;
        // The Map build is O(n) but pointer-cheap — the expensive per-event
        // parsing (parseWebSearchResultText, deriveStepLabelFromName) already ran
        // only for the appended events inside the reducer above.
        map = payloadsToMap(payloads);
        return map;
      }

      // Mutate-last: text-delta coalescing. Re-apply only the grown tail.
      case "mutate-last": {
        const len = events.length;
        const payloadsClone = payloads.slice();
        const metaClone = meta.slice();

        // A text event contributes 0 or 1 trailing `thinking` payload (keyed by
        // the event id) and never mutates earlier payloads, so popping the keyed
        // tail (if present) and re-applying the grown event reproduces the full
        // rebuild exactly. Unlike the step projection there is NO tail-identity
        // shortcut: `thinkingText` carries the full untruncated content, so the
        // payload changes on every delta — but the replay is still O(Δ).
        const tail = payloadsClone[payloadsClone.length - 1];
        if (
          tail &&
          tail.kind === "thinking" &&
          tail.toolCallId === events[len - 1]!.id
        ) {
          payloadsClone.pop();
          metaClone.pop();
        }

        reducer(payloadsClone, metaClone, events[len - 1]!);

        prevEvents = events;
        payloads = payloadsClone;
        meta = metaClone;
        map = payloadsToMap(payloads);
        return map;
      }

      // Fallback — full-replace / truncation / reorder / violated assumption.
      case "fallback":
        return fullBuild(events);
    }
  }

  return { project };
}

/**
 * Hook wrapper: holds an incremental detail projector per component instance (in
 * a `useRef`, tied to the component's lifecycle — never a module-global cache,
 * so independent panels don't share/thrash one slot). Returns the projected
 * `toolCallId`-keyed `Map`.
 */
export function useSubagentStepDetails(
  events: SubagentTimelineEvent[],
): Map<string, ToolDetailPayload> {
  const projectorRef = useRef<ReturnType<
    typeof createIncrementalDetailProjection
  > | null>(null);

  // Intentional render-phase ref usage: the projector is a per-instance mutable
  // cache (like `useMemo` but with custom diff-aware equality), so its identity
  // must be stable across renders and `project(events)` must run on every render
  // to fold in new events. Reading `.current` here is the whole point — the same
  // lazy-init + cache pattern `useSubagentSteps` / `use-event-stream.ts` use.
  /* eslint-disable react-hooks/refs -- per-instance projection cache (see above) */
  if (projectorRef.current == null) {
    projectorRef.current = createIncrementalDetailProjection();
  }
  return projectorRef.current.project(events);
  /* eslint-enable react-hooks/refs */
}
