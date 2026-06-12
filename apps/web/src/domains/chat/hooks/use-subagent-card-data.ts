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
 * Types (`ToolCallCardData`, `ToolCallCardStep`) are imported from
 * `use-tool-call-card-data.ts` so the subagent and tool-call cards share
 * one renderer-contract source of truth. The subagent-only `tool_error`
 * variant lives in that same union — see the file header there for the
 * full per-kind table.
 *
 * Step-kind mapping:
 * - `text` timeline event → `kind: "thinking"` with the content trimmed
 *   to a single line of ≤160 chars.
 * - `tool_call` timeline event → `kind: "tool"` with a humanised title
 *   derived from `toolName`. A subsequent `tool_result` event for the
 *   same `toolUseId` flips the step's `status` to `"completed"` (or
 *   `"error"` when `isError` is set) and stamps a duration label.
 * - `error` timeline event → `kind: "tool_error"` with the event content
 *   as the surfaced error message. Closes any preceding in-flight tool
 *   step so the body doesn't show a stale loader.
 */

import { useMemo } from "react";

import {
  useSubagentStore,
  type SubagentEntry,
  type SubagentTimelineEvent,
} from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";
import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import { truncate } from "@/domains/chat/utils/truncate";
import {
  formatMs,
  type ToolCallCardData,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";

export type { ToolCallCardData, ToolCallCardStep };

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
  return truncate(collapsed, TEXT_PREVIEW_MAX);
}

/**
 * Best-effort reconstruction of a tool input bag from a subagent timeline
 * event. Subagent events carry only a `content` summary string (produced by
 * `summarizeToolInput` in the store) — not the raw input object — so we
 * stuff that summary back into the most likely input key for the tool. The
 * resulting bag is good enough for `deriveStepLabelFromName` to recover
 * tool-specific labels (bash command, file path, computer action, etc.)
 * instead of falling back to the generic "Running <Name>" path.
 *
 * Tools not enumerated here fall through to `deriveStepLabelFromName`'s
 * default branch, which still produces a sensible title + the `bolt` icon.
 */
function reconstructInputBag(
  toolName: string,
  content: string,
): Record<string, unknown> {
  const name = toolName.toLowerCase();
  if (!content) return {};

  switch (name) {
    case "bash":
    case "host_bash":
      return { command: content };
    case "str_replace_editor":
    case "text_editor":
      // We lack the editor sub-command in the timeline summary, so route
      // through "Editing" by default — safer than mis-classifying writes
      // as reads. Callers who need the precise variant can wire raw input
      // through when the subagent store starts preserving it.
      return { path: content };
    case "computer":
      return { action: content };
    case "skill":
    case "skill_execute":
    case "skill_invoke":
    case "skill_load":
      return { skill: content };
    case "subagent_spawn":
      return { label: content };
    default:
      return {};
  }
}

/**
 * Map a subagent `tool_call` timeline event into a fresh in-flight `tool`
 * step. Exposed for testability.
 *
 * Routes through the shared `deriveStepLabelFromName` helper so the inline
 * card's step pills inherit tool-specific titles + icons (`code` for bash,
 * `file` for str_replace_editor view, etc.) rather than always rendering
 * `bolt` / generic "Using <Tool>" labels. The subagent timeline carries
 * only a `content` summary string (no raw input object), so we
 * best-effort-reconstruct an input bag via `reconstructInputBag` before
 * dispatching.
 *
 * `toolCallId` mirrors `toolUseId` so the renderer key + result matcher
 * have a stable identifier.
 */
export function mapToolEventToStep(
  event: SubagentTimelineEvent,
): Extract<ToolCallCardStep, { kind: "tool" }> {
  const toolName = event.toolName ?? "";
  const content = event.content ?? "";
  const input = reconstructInputBag(toolName, content);
  const label = deriveStepLabelFromName(toolName, input);
  return {
    kind: "tool",
    durationLabel: "",
    toolCallId: event.toolUseId ?? "",
    iconName: label.iconName,
    title: label.title,
    info: label.info || content,
    activity: label.activity,
    status: "running",
  };
}

/**
 * Find the index of the most recent in-flight tool step that matches a
 * follow-up event (`tool_result` or `error`). Match precedence:
 *   1. Exact `toolUseId` match — required when the event carries one (so
 *      parallel calls to the same tool don't bleed into each other).
 *   2. `toolName` match against the originating `tool_call`'s name.
 *   3. "Latest in-flight" — when neither identifier is present.
 *
 * Returns -1 when no in-flight step matches.
 */
function findMatchingInFlightToolIndex(
  steps: ToolCallCardStep[],
  toolMeta: Array<{ startTs: number; toolName: string } | undefined>,
  event: { toolUseId?: string; toolName?: string },
): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind !== "tool" || step.status !== "running") continue;
    if (event.toolUseId) {
      if (step.toolCallId === event.toolUseId) return i;
      // Exact-match-only when the event carries a toolUseId — do NOT fall
      // through to toolName matching for a different ID.
      continue;
    }
    const stepToolName = toolMeta[i]?.toolName ?? "";
    if (!event.toolName || stepToolName === event.toolName) return i;
  }
  return -1;
}

/**
 * Translate the subagent's status to a shell-compatible visual state.
 * `awaiting_input` is treated as `"loading"` (the subagent is waiting on
 * a human reply but the card chrome still reads as in-flight). `aborted`
 * surfaces as `"error"` so the card doesn't read as a clean completion.
 */
function deriveCardState(status: SubagentStatus): ToolCallCardData["state"] {
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
  // Parallel array tracking per-tool metadata not carried on the shared
  // `tool` step shape: the start timestamp (for duration calc) and the
  // originating `toolName` (so the resting "Used <Tool>" header can
  // re-humanise the name without re-parsing the title string). Indexed
  // by `steps` position; `undefined` for non-tool entries.
  const toolMeta: Array<
    { startTs: number; toolName: string } | undefined
  > = [];

  for (const event of entry.events) {
    if (event.type === "text") {
      const text = trimTextPreview(event.content);
      // Skip empty text events — they'd render as a blank thinking step.
      if (text.length === 0) continue;
      steps.push({ kind: "thinking", durationLabel: "", text });
      toolMeta.push(undefined);
      continue;
    }

    if (event.type === "tool_call") {
      steps.push(mapToolEventToStep(event));
      toolMeta.push({
        startTs: event.timestamp,
        toolName: event.toolName ?? "",
      });
      continue;
    }

    if (event.type === "tool_result") {
      const matchIndex = findMatchingInFlightToolIndex(steps, toolMeta, event);
      if (matchIndex === -1) continue;
      const target = steps[matchIndex]!;
      if (target.kind !== "tool") continue;
      const start = toolMeta[matchIndex]?.startTs;
      const durationLabel =
        typeof start === "number" && Number.isFinite(start)
          ? formatMs(event.timestamp - start)
          : "";
      steps[matchIndex] = {
        ...target,
        status: event.isError ? "error" : "completed",
        durationLabel,
      };
      continue;
    }

    if (event.type === "error") {
      // Close the matching in-flight tool step (if any) as `error` before
      // appending the `tool_error` row. Same matching precedence as
      // `tool_result` — see `findMatchingInFlightToolIndex` — so parallel
      // calls to the same tool close the correct step.
      const matchIndex = findMatchingInFlightToolIndex(steps, toolMeta, event);
      if (matchIndex !== -1) {
        const target = steps[matchIndex]!;
        if (target.kind === "tool") {
          steps[matchIndex] = { ...target, status: "error" };
        }
      }
      const message = trimTextPreview(event.content) || "Subagent error";
      steps.push({ kind: "tool_error", message });
      toolMeta.push(undefined);
      continue;
    }
  }

  const state = deriveCardState(entry.status);
  const { currentStepTitle, currentStepInfo } = deriveCurrentStep(
    entry,
    steps,
    toolMeta,
  );

  const stepCount = `${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return {
    state,
    currentStepTitle,
    currentStepInfo,
    stepCount,
    steps,
    // Subagent cards don't use the web-search carousel — the inline
    // renderer slots its own `SubagentAvatarChip` into the shell via
    // `ToolProgressCardShell.leadingIcon` directly.
    carouselItems: [],
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
 *   - no steps and status `completed` → "Finished"
 *   - no steps and status `failed` / `aborted` → "Failed" / "Aborted"
 *
 * "Finalizing" — status is `running` but there are steps and no tool
 * currently in flight — reads as "the subagent has work in progress but
 * isn't actively waiting on a tool result". This matches the macOS
 * subagent header semantics so cross-platform copy stays aligned.
 */
function deriveCurrentStep(
  entry: SubagentEntry,
  steps: ToolCallCardStep[],
  toolMeta: Array<{ startTs: number; toolName: string } | undefined>,
): { currentStepTitle: string; currentStepInfo: string } {
  const isTerminal =
    entry.status === "completed" ||
    entry.status === "failed" ||
    entry.status === "aborted";

  if (steps.length === 0) {
    // Branch on the actual terminal status so a subagent that failed or
    // aborted before emitting any events doesn't read as "Finished".
    let title: string;
    if (entry.status === "failed") title = "Failed";
    else if (entry.status === "aborted") title = "Aborted";
    else if (entry.status === "completed") title = "Finished";
    else title = "Working";
    return {
      currentStepTitle: title,
      // Falls back to the label when `error` is missing OR an empty
      // string — daemon errors are sometimes set to "" before a real
      // message lands, and an empty subtitle would read as a layout bug.
      currentStepInfo: entry.error || entry.label,
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
    const toolName = toolMeta[steps.length - 1]?.toolName ?? "";
    return {
      currentStepTitle: toolName
        ? `Used ${titleCaseToolName(toolName)}`
        : "Done",
      currentStepInfo: latest.info,
    };
  }

  if (latest.kind === "tool_error") {
    return {
      currentStepTitle: "Errored",
      currentStepInfo: latest.message,
    };
  }

  // `web_search` / `web_search_error` aren't produced by this hook today,
  // but the union includes them — fall through to a neutral header.
  return { currentStepTitle: "", currentStepInfo: "" };
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
