/**
 * Builds the props for `SubagentInlineProgressCard` from a single
 * subagent's store entry. Translates the subagent's timeline events
 * (`SubagentTimelineEvent[]`) into the unified `ToolCallCardStep[]`
 * shape consumed by the shared tool-progress card chrome.
 *
 * The hook returns `null` when no entry exists for the given subagent ID
 * yet — that's the spawn-race case where the assistant message containing
 * the inline card mounts before the `subagent_spawned` event lands. The
 * card renders `null` in that window so the transcript layout doesn't
 * jiggle.
 *
 * This module is intentionally self-contained: it owns the
 * `ToolCallCardData` / `ToolCallCardStep` types it emits. The pure
 * projection `computeSubagentCardData(entry)` is exported alongside the
 * hook so tests can drive it without React or the Zustand context.
 *
 * Step-kind mapping:
 * - `text` timeline event → `kind: "thinking"` with the content trimmed
 *   to a single line of ≤160 chars.
 * - `tool_call` timeline event → `kind: "tool"` with a humanised title
 *   derived from `toolName`. A subsequent `tool_result` event for the
 *   same tool flips the step's `status` to `"complete"` (or `"error"`
 *   when `isError` is set) and stamps a duration label.
 * - `error` timeline event → `kind: "tool_error"` with the event content
 *   as the surfaced error message. Closes any preceding in-flight tool
 *   step so the body doesn't show a stale loader.
 */

import { useMemo } from "react";

import {
  useSubagentStore,
  type SubagentEntry,
  type SubagentTimelineEvent,
} from "@/domains/subagents/subagent-store.js";
import type { SubagentStatus } from "@/domains/chat/api/event-types.js";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell.js";
import { humanizeToolName } from "@/domains/chat/components/tool-progress-card/derive-step-label.js";
import { formatMs } from "@/domains/chat/hooks/use-web-search-card-data.js";

// ---------------------------------------------------------------------------
// Public types — mirrors the shape PR 5 (useToolCallCardData) will land.
// ---------------------------------------------------------------------------

/**
 * A single sub-step inside the expanded card. Discriminated by `kind`:
 *  - `"thinking"`   → text reasoning step (no tool involved).
 *  - `"tool"`       → tool invocation step. `status` flips from
 *                     `"running"` → `"complete"` / `"error"` once the
 *                     matching `tool_result` arrives.
 *  - `"tool_error"` → a tool-error timeline event with no preceding
 *                     in-flight `tool_call` (e.g. a synthesised abort).
 */
export type ToolCallCardStep =
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolName: string;
      title: string;
      info: string;
      status: "running" | "complete" | "error";
      durationLabel?: string;
    }
  | { kind: "tool_error"; message: string };

/** Props the unified tool-progress card consumes. */
export interface ToolCallCardData {
  state: ToolProgressCardState;
  currentStepTitle: string;
  currentStepInfo: string;
  stepCount: string;
  steps: ToolCallCardStep[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEXT_PREVIEW_MAX = 160;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Trim newlines + collapse whitespace, then clamp to TEXT_PREVIEW_MAX. */
function trimTextPreview(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TEXT_PREVIEW_MAX) return collapsed;
  // -1 to leave room for the ellipsis. Mirrors `derive-step-label.ts`.
  return collapsed.slice(0, TEXT_PREVIEW_MAX - 1) + "…";
}

/**
 * Map a subagent `tool_call` timeline event into a fresh in-flight `tool`
 * step. Exposed for testability — kept separate from `deriveStepLabel`
 * because the subagent timeline event has a different shape (`toolName`
 * + `content` summary) than the assistant-side `ChatMessageToolCall`.
 */
export function mapToolEventToStep(
  event: SubagentTimelineEvent,
): Extract<ToolCallCardStep, { kind: "tool" }> {
  const toolName = event.toolName ?? "";
  return {
    kind: "tool",
    toolName,
    title: toolName ? `Using ${humanizeToolName(toolName)}` : "Running tool",
    info: event.content ?? "",
    status: "running",
  };
}

/**
 * Translate the subagent's status to a shell-compatible visual state.
 * `awaiting_input` is treated as `"loading"` (the subagent is waiting on
 * a human reply but the card chrome still reads as in-flight). `aborted`
 * surfaces as `"error"` so the card doesn't read as a clean completion.
 */
function deriveCardState(status: SubagentStatus): ToolProgressCardState {
  switch (status) {
    case "running":
    case "pending":
    case "awaiting_input":
      return "loading";
    case "completed":
      return "complete";
    case "failed":
    case "aborted":
      return "error";
    default:
      return "loading";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure projection of (entry) → card props. Split from the hook so tests
 * can drive it without instantiating the Zustand store.
 */
export function computeSubagentCardData(
  entry: SubagentEntry,
): ToolCallCardData {
  const steps: ToolCallCardStep[] = [];
  // Parallel array tracking the `tool_call` timestamp for each `tool`
  // step so the matching `tool_result` can compute a duration. Indexed
  // by `steps` position; `undefined` for non-tool entries.
  const toolStartTs: Array<number | undefined> = [];

  for (const event of entry.events) {
    if (event.type === "text") {
      const text = trimTextPreview(event.content);
      // Skip empty text events — they'd render as a blank thinking step.
      if (text.length === 0) continue;
      steps.push({ kind: "thinking", text });
      toolStartTs.push(undefined);
      continue;
    }

    if (event.type === "tool_call") {
      steps.push(mapToolEventToStep(event));
      toolStartTs.push(event.timestamp);
      continue;
    }

    if (event.type === "tool_result") {
      // Close the most recent matching in-flight tool step. Match by
      // `toolName` when available so an out-of-order pair doesn't close
      // the wrong step; fall back to "latest in-flight tool" otherwise.
      let matchIndex = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if (step.kind !== "tool" || step.status !== "running") continue;
        if (!event.toolName || step.toolName === event.toolName) {
          matchIndex = i;
          break;
        }
      }
      if (matchIndex === -1) continue;
      const target = steps[matchIndex] as Extract<
        ToolCallCardStep,
        { kind: "tool" }
      >;
      const start = toolStartTs[matchIndex];
      const durationLabel =
        typeof start === "number" && Number.isFinite(start)
          ? formatMs(event.timestamp - start)
          : undefined;
      steps[matchIndex] = {
        ...target,
        status: event.isError ? "error" : "complete",
        durationLabel,
      };
      continue;
    }

    if (event.type === "error") {
      // If there's an in-flight tool, close it as error.
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if (step.kind === "tool" && step.status === "running") {
          steps[i] = { ...step, status: "error" };
          break;
        }
      }
      const message = trimTextPreview(event.content) || "Subagent error";
      steps.push({ kind: "tool_error", message });
      toolStartTs.push(undefined);
      continue;
    }
  }

  const state = deriveCardState(entry.status);
  const { currentStepTitle, currentStepInfo } = deriveCurrentStep(
    entry,
    steps,
  );

  const stepCount = `${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return {
    state,
    currentStepTitle,
    currentStepInfo,
    stepCount,
    steps,
  };
}

/**
 * Derive the carousel `(title, info)` tuple from the entry status + step
 * stream. The title reflects what the subagent is doing *right now*:
 *   - latest step is `thinking` → "Thinking" (or "Thought" terminal)
 *   - latest step is a running tool → "Working"
 *   - latest step is a completed tool → "Used <Tool>"
 *   - latest step is an error → "Errored"
 *   - no steps yet but status is running → "Working"
 *   - no steps and status terminal → "Finished"
 *
 * "Finalizing" — status is `running` but there are steps and no tool
 * currently in flight — reads as "the subagent has work in progress but
 * isn't actively waiting on a tool result". This matches the macOS
 * subagent header semantics so cross-platform copy stays aligned.
 */
function deriveCurrentStep(
  entry: SubagentEntry,
  steps: ToolCallCardStep[],
): { currentStepTitle: string; currentStepInfo: string } {
  const isTerminal =
    entry.status === "completed" ||
    entry.status === "failed" ||
    entry.status === "aborted";

  if (steps.length === 0) {
    return {
      currentStepTitle: isTerminal ? "Finished" : "Working",
      currentStepInfo: entry.label,
    };
  }

  const latest = steps[steps.length - 1]!;

  if (latest.kind === "thinking") {
    // Subagent has emitted text most recently. If it's still running
    // we're "Thinking"; if it's terminal we surface the past tense so
    // the resting card doesn't read as live.
    return {
      currentStepTitle: isTerminal ? "Thought" : "Thinking",
      currentStepInfo: latest.text,
    };
  }

  if (latest.kind === "tool") {
    const inFlight = latest.status === "running";
    if (inFlight) {
      return {
        currentStepTitle: "Working",
        currentStepInfo: latest.info,
      };
    }
    // Tool just closed — title swaps to "Used <Tool>". When the
    // subagent reports `running` after a tool closed (no new tool in
    // flight, no text yet) we read as "Finalizing".
    if (!isTerminal) {
      return {
        currentStepTitle: "Finalizing",
        currentStepInfo: latest.info,
      };
    }
    return {
      currentStepTitle: latest.toolName
        ? `Used ${humanizeToolName(latest.toolName)}`
        : "Done",
      currentStepInfo: latest.info,
    };
  }

  // tool_error
  return {
    currentStepTitle: "Errored",
    currentStepInfo: latest.message,
  };
}

/**
 * React hook: subscribe to the subagent store entry for `subagentId`
 * and project it into `ToolCallCardData`. Returns `null` when no entry
 * exists yet (spawn race) so callers can short-circuit rendering.
 */
export function useSubagentCardData(
  subagentId: string,
): ToolCallCardData | null {
  const entry = useSubagentStore((state) => state.byId[subagentId]);
  return useMemo(() => {
    if (!entry) return null;
    return computeSubagentCardData(entry);
  }, [entry]);
}
