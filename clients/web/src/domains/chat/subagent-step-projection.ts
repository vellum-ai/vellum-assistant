/**
 * Incremental step projection for a subagent's timeline.
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
 *     misclassify a subagent switch as mutate-last and leave a stale step that a
 *     full rebuild drops (then a stale pill/key could open the previous
 *     subagent's detail).
 *  3. **Full-replace** — `loadDetail` swaps the whole array (history hydration /
 *     subagent switch).
 *
 * `computeSubagentSteps(events)` is O(n); running it on every streamed event
 * would be O(n²) over a run. This projector replays only the
 * events that changed since the last call, folding them through the **same**
 * `applyTimelineEvent` reducer the full rebuild uses — so the incremental and
 * full paths can never drift. Any diff that doesn't fit the append / mutate-last
 * shapes (full-replace, truncation, reorder, or a violated assumption) falls
 * back to a full O(n) `computeSubagentSteps` rebuild, which is always correct.
 *
 * Note: a `tool_result` / `error` event closes an in-flight tool by writing at
 * an *earlier* step's match index, so projection is append-MOSTLY, not
 * append-only — which is exactly why we reuse the real reducer instead of a
 * naive "push one step."
 */

import { useRef } from "react";

import {
  applyTimelineEvent,
  computeSubagentSteps,
  type ToolCallCardStep,
  type ToolMeta,
} from "@/domains/chat/hooks/use-subagent-card-data";
import { classifyEventsDiff } from "@/domains/chat/subagent-projection-diff";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

export interface ProjectedSteps {
  steps: ToolCallCardStep[];
  toolMeta: Array<ToolMeta | undefined>;
}

/**
 * Structural equality for two timeline steps. The steps are flat objects (only
 * `results` carries a nested array), so a shallow JSON compare is both correct
 * and cheap — used only on the single re-derived tail step in the mutate-last
 * path to decide whether the array identity can be preserved.
 */
function stepsEqual(a: ToolCallCardStep, b: ToolCallCardStep): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The per-event reducer signature shared by the full and incremental paths. */
type TimelineReducer = (
  steps: ToolCallCardStep[],
  toolMeta: Array<ToolMeta | undefined>,
  event: SubagentTimelineEvent,
) => void;

/**
 * Create a stateful incremental projector. `project(events)` returns the
 * `{ steps, toolMeta }` for `events`, replaying only the diff vs the previous
 * call through `applyTimelineEvent`. The returned arrays are cached; identical
 * inputs (or no-op text deltas past the preview clamp) return the cached arrays
 * by reference so downstream memo / `React.memo` consumers can bail.
 *
 * One projector instance owns one cache slot — hold it per component instance
 * (see `useSubagentSteps`), never module-global, so the panel and N inline
 * cards don't thrash a single slot.
 *
 * `reducer` defaults to the real `applyTimelineEvent`; it's a seam for the
 * incremental-work guard test to count reducer invocations without mocking.
 */
export function createIncrementalStepProjection(
  reducer: TimelineReducer = applyTimelineEvent,
) {
  let prevEvents: SubagentTimelineEvent[] | null = null;
  let steps: ToolCallCardStep[] = [];
  let toolMeta: Array<ToolMeta | undefined> = [];

  function fullBuild(events: SubagentTimelineEvent[]): ProjectedSteps {
    const built = computeSubagentSteps(events);
    prevEvents = events;
    steps = built.steps;
    toolMeta = built.toolMeta;
    return { steps, toolMeta };
  }

  function project(events: SubagentTimelineEvent[]): ProjectedSteps {
    // The diff classification (including the subtle cross-subagent `detail-1`
    // id-collision guard) is shared with the detail projector — see
    // `subagent-projection-diff.ts`.
    const diff = classifyEventsDiff(prevEvents, events);

    switch (diff.kind) {
      // Identity — also covers events-stable status/usage updates.
      case "identity":
        return { steps, toolMeta };

      // First call / empty cache.
      case "first":
        return fullBuild(events);

      // Append: same prefix, one-or-more new events at the tail. Replay only
      // the appended events through the reducer.
      case "append": {
        const len = events.length;
        const stepsClone = steps.slice();
        const toolMetaClone = toolMeta.slice();
        for (let i = diff.from; i < len; i++) {
          reducer(stepsClone, toolMetaClone, events[i]!);
        }
        prevEvents = events;
        steps = stepsClone;
        toolMeta = toolMetaClone;
        return { steps, toolMeta };
      }

      // Mutate-last: text-delta coalescing. Re-derive only the grown tail.
      case "mutate-last": {
        const len = events.length;
        const stepsClone = steps.slice();
        const toolMetaClone = toolMeta.slice();

        // A text event contributes 0 or 1 trailing thinking step and never
        // mutates earlier steps, so popping the keyed tail (if present) and
        // re-deriving from the grown content reproduces the full rebuild exactly.
        const tail = stepsClone[stepsClone.length - 1];
        let poppedStep: ToolCallCardStep | undefined;
        if (tail && tail.kind === "thinking" && tail.detailKey === events[len - 1]!.id) {
          poppedStep = tail;
          stepsClone.pop();
          toolMetaClone.pop();
        }

        reducer(stepsClone, toolMetaClone, events[len - 1]!);

        prevEvents = events;
        const newTail = stepsClone[stepsClone.length - 1];
        // Identity preservation — once the collapsed preview passes the 160-char
        // clamp, further deltas don't change the rendered step. Keep the previous
        // `steps` reference so memo / `React.memo` consumers bail. (toolMeta is
        // re-derived identically too; reuse the prior reference for the same win.)
        if (poppedStep && newTail && stepsEqual(poppedStep, newTail)) {
          return { steps, toolMeta };
        }
        steps = stepsClone;
        toolMeta = toolMetaClone;
        return { steps, toolMeta };
      }

      // Fallback — full-replace / truncation / reorder / violated assumption.
      case "fallback":
        return fullBuild(events);
    }
  }

  return { project };
}

/**
 * Hook wrapper: holds an incremental projector per component instance (in a
 * `useRef`, tied to the component's lifecycle — never a module-global cache, so
 * the panel and N inline cards don't share/thrash one slot). Returns the
 * projector output, stabilizing the wrapper object's identity when both arrays
 * are unchanged so callers that compare the `{ steps, toolMeta }` object also
 * bail.
 */
export function useSubagentSteps(
  events: SubagentTimelineEvent[],
): ProjectedSteps {
  const projectorRef = useRef<ReturnType<
    typeof createIncrementalStepProjection
  > | null>(null);
  const lastRef = useRef<ProjectedSteps | null>(null);

  // Intentional render-phase ref usage: the projector is a per-instance
  // mutable cache (like `useMemo` but with custom diff-aware equality), so its
  // identity must be stable across renders and `project(events)` must run on
  // every render to fold in new events. Reading `.current` here is the whole
  // point — the same lazy-init + cache pattern `use-event-stream.ts` uses.
  /* eslint-disable react-hooks/refs -- per-instance projection cache (see above) */
  if (projectorRef.current == null) {
    projectorRef.current = createIncrementalStepProjection();
  }
  const next = projectorRef.current.project(events);
  const last = lastRef.current;
  // Stabilize the wrapper object's identity when both arrays are unchanged so
  // callers comparing the `{ steps, toolMeta }` object (not just the arrays)
  // also bail.
  if (last != null && last.steps === next.steps && last.toolMeta === next.toolMeta) {
    return last;
  }
  lastRef.current = next;
  return next;
  /* eslint-enable react-hooks/refs */
}
