/**
 * Incremental step projection for an ACP run's timeline.
 *
 * Folds the raw ACP event buffer (`AcpRunRawEvent[]` from `acp-run-store.ts`)
 * into an ordered `AcpTimelineStep[]` — a discriminated union of tool / message
 * / thought / plan steps consumed by the inline card and detail panel.
 *
 * The store appends each event to `entry.events` (see `acp-run-store.ts`
 * `appendEvent`); message/thought chunks are NOT coalesced in the buffer, so
 * the live shape is always a plain **append** — `[...events, ev]`, a new array
 * with every prior element reference-equal and one new element at the tail.
 * Coalescing same-`messageId` chunks into a single rendered message happens
 * here in the projection, not the buffer.
 *
 * `computeAcpRunSteps(events)` is O(n); running it on every streamed event is
 * O(n^2) over a run. This projector replays only the diff vs the previous call
 * through the same `applyAcpEvent` reducer the full rebuild uses, so the
 * incremental and full paths can never drift. Any diff that isn't a plain
 * append (full-replace on history hydration, truncation, reorder, or a
 * same-length last-element change) falls back to a full O(n) rebuild, which is
 * always correct. The common streaming path is plain append, so the
 * incremental win is preserved there.
 *
 * `isComplete` rule for message steps: a message step flips to `isComplete:
 * true` once any later step is appended after it (a different message,
 * thought, tool, or plan starts). The trailing message step is left
 * `isComplete: false` until the run produces a subsequent step or terminates.
 * Best-effort — sufficient for the UI to stop showing a live caret.
 */

import { useRef } from "react";

import type { AcpRunRawEvent } from "@/domains/chat/acp-run-store";

// ---------------------------------------------------------------------------
// Timeline step union
// ---------------------------------------------------------------------------

export type AcpToolStatus = "running" | "completed" | "error";

export type AcpTimelineStep =
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: AcpToolStatus;
      outputChunks: string[];
      detailKey: string;
    }
  | {
      kind: "message";
      messageId: string;
      content: string;
      isComplete: boolean;
      detailKey: string;
    }
  | {
      kind: "thought";
      messageId: string;
      content: string;
      detailKey: string;
    }
  | {
      kind: "plan";
      entries: { label: string; checked: boolean }[];
      detailKey: "plan";
    };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Synthetic id for chunks from older daemons that don't emit a messageId. */
const ANONYMOUS_MESSAGE_ID = "";

/** Map a raw daemon `toolStatus` to a step status; keep `fallback` if absent. */
function mapToolStatus(
  toolStatus: string | undefined,
  fallback: AcpToolStatus,
): AcpToolStatus {
  switch (toolStatus) {
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "error";
    case undefined:
      return fallback;
    default:
      return "running";
  }
}

/** Mark the most recent message step (if any, and still live) as complete. */
function closeTrailingMessage(steps: AcpTimelineStep[]): void {
  const last = steps[steps.length - 1];
  if (last && last.kind === "message" && !last.isComplete) {
    steps[steps.length - 1] = { ...last, isComplete: true };
  }
}

/**
 * Fold a single raw ACP event into `steps` (mutated in place). Shared by the
 * full rebuild and the incremental projector so the two paths can't diverge.
 */
export function applyAcpEvent(
  steps: AcpTimelineStep[],
  event: AcpRunRawEvent,
): void {
  switch (event.updateType) {
    case "tool_call": {
      const toolCallId = event.toolCallId;
      if (toolCallId === undefined) return;
      closeTrailingMessage(steps);
      steps.push({
        kind: "tool",
        toolCallId,
        title: event.toolTitle ?? "",
        toolKind: event.toolKind,
        status: "running",
        // Content (if carried) is the initial snapshot, same as tool_call_update.
        outputChunks: event.content !== undefined ? [event.content] : [],
        detailKey: `tool:${toolCallId}`,
      });
      return;
    }

    case "tool_call_update": {
      const toolCallId = event.toolCallId;
      if (toolCallId === undefined) return;
      const index = steps.findIndex(
        (s) => s.kind === "tool" && s.toolCallId === toolCallId,
      );
      if (index === -1) return;
      const target = steps[index] as Extract<AcpTimelineStep, { kind: "tool" }>;
      // ACP `ToolCallUpdate.content` REPLACES the tool's content collection: the
      // daemon forwards each update as the full current snapshot, not a delta.
      // Hold the latest snapshot as the sole element so `.join("")` still works.
      const outputChunks =
        event.content !== undefined ? [event.content] : target.outputChunks;
      steps[index] = {
        ...target,
        title: event.toolTitle ?? target.title,
        toolKind: event.toolKind ?? target.toolKind,
        status: mapToolStatus(event.toolStatus, target.status),
        outputChunks,
      };
      return;
    }

    case "agent_message_chunk": {
      const messageId = event.messageId ?? ANONYMOUS_MESSAGE_ID;
      // Coalesce into the tail only when ids match. Anonymous chunks (no
      // `messageId`) match each other while a message step is still the tail;
      // an intervening non-message event makes the tail non-message, so the
      // next anonymous chunk starts a fresh message (the gap-fallback boundary).
      const last = steps[steps.length - 1];
      if (last && last.kind === "message" && last.messageId === messageId) {
        steps[steps.length - 1] = {
          ...last,
          content: last.content + (event.content ?? ""),
        };
        return;
      }
      // Some agents stream a message as id-less deltas, then re-send the whole
      // message as one chunk that finally carries a messageId. Adopt the id
      // onto the streamed step rather than opening a duplicate of it.
      if (
        messageId !== ANONYMOUS_MESSAGE_ID &&
        last &&
        last.kind === "message" &&
        last.messageId === ANONYMOUS_MESSAGE_ID &&
        !last.isComplete &&
        last.content === (event.content ?? "")
      ) {
        steps[steps.length - 1] = {
          ...last,
          messageId,
          detailKey: `msg:${messageId}`,
        };
        return;
      }
      closeTrailingMessage(steps);
      steps.push({
        kind: "message",
        messageId,
        content: event.content ?? "",
        isComplete: false,
        detailKey: `msg:${messageId}`,
      });
      return;
    }

    case "agent_thought_chunk": {
      const messageId = event.messageId ?? ANONYMOUS_MESSAGE_ID;
      const last = steps[steps.length - 1];
      if (last && last.kind === "thought" && last.messageId === messageId) {
        steps[steps.length - 1] = {
          ...last,
          content: last.content + (event.content ?? ""),
        };
        return;
      }
      closeTrailingMessage(steps);
      steps.push({
        kind: "thought",
        messageId,
        content: event.content ?? "",
        detailKey: `thought:${messageId}`,
      });
      return;
    }

    case "plan": {
      const entries = parsePlanEntries(event.content);
      if (entries === null) return;
      const index = steps.findIndex((s) => s.kind === "plan");
      const planStep: AcpTimelineStep = {
        kind: "plan",
        entries,
        detailKey: "plan",
      };
      if (index === -1) {
        // First plan step is a later timeline step; close any live message.
        closeTrailingMessage(steps);
        steps.push(planStep);
      } else {
        steps[index] = planStep;
      }
      return;
    }

    case "user_message_chunk":
      // User echoes don't belong in the agent timeline.
      return;
  }
}

/**
 * Parse a `plan` event's JSON `content` into entries. Returns `null` (skip the
 * event) on malformed JSON or an unexpected shape rather than throwing.
 */
function parsePlanEntries(
  content: string | undefined,
): { label: string; checked: boolean }[] | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown })?.entries)
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (raw === null) return null;
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    // ACP `PlanEntry` carries its text in `content`; older shapes used `label`.
    const text = obj.content ?? obj.label ?? "";
    return {
      label: typeof text === "string" ? text : String(text),
      checked: obj.checked === true || obj.status === "completed",
    };
  });
}

/**
 * Build the full `AcpTimelineStep[]` for an event buffer by folding
 * `applyAcpEvent` over each event. Single source of truth for the projection.
 */
export function computeAcpRunSteps(events: AcpRunRawEvent[]): AcpTimelineStep[] {
  const steps: AcpTimelineStep[] = [];
  for (const event of events) applyAcpEvent(steps, event);
  return steps;
}

// ---------------------------------------------------------------------------
// Incremental projector
// ---------------------------------------------------------------------------

/**
 * Classify how `next` differs from `prev` at the raw-event-array level.
 *  - `identity` — same array reference.
 *  - `first` — no previous (cold cache).
 *  - `append` — `prev` is a strict prefix of `next` (every prior element
 *    reference-equal); replay events from `prev.length`.
 *  - `mutate-last` — same length, all-but-last reference-equal, last element
 *    is a grown message/thought chunk; cheap re-derivation isn't safe so the
 *    caller does a full rebuild.
 *  - `fallback` — anything else (full-replace, truncation, reorder).
 */
function classifyAcpDiff(
  prev: AcpRunRawEvent[] | null,
  next: AcpRunRawEvent[],
): { kind: "identity" | "first" | "mutate-last" | "fallback" } | {
  kind: "append";
  from: number;
} {
  if (prev === next) return { kind: "identity" };
  if (prev === null) return { kind: "first" };
  if (next.length < prev.length) return { kind: "fallback" };

  // Every element of `prev` must be reference-equal to its `next` counterpart
  // for an append. The store preserves references on append, so a single
  // mismatch means a deeper edit happened.
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) {
      // First mismatch at the last index, same length → mutate-last candidate.
      if (i === prev.length - 1 && next.length === prev.length) {
        return { kind: "mutate-last" };
      }
      return { kind: "fallback" };
    }
  }

  if (next.length === prev.length) return { kind: "identity" };
  return { kind: "append", from: prev.length };
}

/**
 * Create a stateful incremental projector. `project(events)` returns the
 * `AcpTimelineStep[]` for `events`, replaying only the diff vs the previous
 * call. Returns the cached array by reference when the input is unchanged so
 * `React.memo` consumers can bail.
 *
 * One projector instance owns one cache slot — hold it per component instance
 * (see `useAcpRunSteps`), never module-global.
 */
export function createAcpRunStepProjection() {
  let prevEvents: AcpRunRawEvent[] | null = null;
  let steps: AcpTimelineStep[] = [];

  function fullBuild(events: AcpRunRawEvent[]): AcpTimelineStep[] {
    steps = computeAcpRunSteps(events);
    prevEvents = events;
    return steps;
  }

  function project(events: AcpRunRawEvent[]): AcpTimelineStep[] {
    const diff = classifyAcpDiff(prevEvents, events);

    switch (diff.kind) {
      case "identity":
        return steps;

      case "first":
        return fullBuild(events);

      case "append": {
        const clone = steps.slice();
        for (let i = diff.from; i < events.length; i++) {
          applyAcpEvent(clone, events[i]!);
        }
        prevEvents = events;
        steps = clone;
        return steps;
      }

      // Message/thought coalescing rewrites a trailing step that may have been
      // built across several prior chunks; a full rebuild is always correct.
      case "mutate-last":
      case "fallback":
        return fullBuild(events);
    }
  }

  return { project };
}

/**
 * Hook wrapper: holds an incremental projector per component instance (in a
 * `useRef`, tied to the component lifecycle — never a module-global cache).
 * Returns a referentially-stable array across renders when the input events
 * are unchanged.
 */
export function useAcpRunSteps(events: AcpRunRawEvent[]): AcpTimelineStep[] {
  const projectorRef = useRef<ReturnType<
    typeof createAcpRunStepProjection
  > | null>(null);

  // Intentional render-phase ref usage: the projector is a per-instance
  // diff-aware cache (like `useMemo`, but it must run every render to fold in
  // new events).
  /* eslint-disable react-hooks/refs -- per-instance projection cache (see above) */
  if (projectorRef.current == null) {
    projectorRef.current = createAcpRunStepProjection();
  }
  return projectorRef.current.project(events);
  /* eslint-enable react-hooks/refs */
}

// ---------------------------------------------------------------------------
// Carousel derivation
// ---------------------------------------------------------------------------

export interface AcpCarouselItem {
  label: string;
  status: AcpToolStatus;
}

/** Default count of trailing steps shown in the inline-card header carousel. */
const DEFAULT_CAROUSEL_COUNT = 3;

/** Single-line label for a step's header-carousel entry. */
function carouselLabel(step: AcpTimelineStep): string {
  switch (step.kind) {
    case "tool":
      return step.title || step.toolKind || "Working";
    case "message":
      return "Responding";
    case "thought":
      return "Thinking";
    case "plan":
      return "Planning";
  }
}

/** Status for a step's header-carousel entry. */
function carouselStatus(step: AcpTimelineStep): AcpToolStatus {
  switch (step.kind) {
    case "tool":
      return step.status;
    case "message":
      return step.isComplete ? "completed" : "running";
    case "thought":
    case "plan":
      return "completed";
  }
}

/**
 * Derive the last N header-carousel items from the projected steps.
 */
export function acpStepsToCarousel(
  steps: AcpTimelineStep[],
  count: number = DEFAULT_CAROUSEL_COUNT,
): AcpCarouselItem[] {
  return steps.slice(-count).map((step) => ({
    label: carouselLabel(step),
    status: carouselStatus(step),
  }));
}
