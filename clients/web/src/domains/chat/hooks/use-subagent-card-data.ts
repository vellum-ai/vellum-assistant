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

import { useRef } from "react";

import {
  useSubagentStore,
  type SubagentEntry,
  type SubagentTimelineEvent,
} from "@/domains/chat/subagent-store";
import { useSubagentSteps } from "@/domains/chat/subagent-step-projection";
import type { SubagentStatus } from "@vellumai/assistant-api";
import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { titleCaseToolName } from "@/domains/chat/components/tool-call-chip/utils";
import { truncate } from "@/domains/chat/utils/truncate";
import {
  extractDomain,
  parseWebSearchResultText,
} from "@/domains/chat/utils/web-search-result-text";
import {
  formatMs,
  WEB_TOOL_NAMES,
  type ToolCallCardData,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import type { ToolDetailPayload } from "@/stores/viewer-store";

export type { ToolCallCardData, ToolCallCardStep };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEXT_PREVIEW_MAX = 160;

/**
 * Shared frozen empty events array for the spawn-race window (no entry yet).
 * A stable reference keeps the projector's identity check happy so the hook
 * doesn't churn while waiting for the `subagent_spawned` event.
 */
const EMPTY_EVENTS: SubagentTimelineEvent[] = [];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Per-step metadata tracked in parallel with `steps` (indexed by step
 * position): the start timestamp (for duration calc), the originating
 * `toolName` (so the resting "Used <Tool>" header can re-humanise it), and the
 * `toolUseId` — needed to match follow-up `tool_result`/`error` events back to
 * `web_search` steps, whose step shape carries no id field. `undefined` for
 * steps with no follow-up (thinking, tool_error).
 */
export type ToolMeta = { startTs: number; toolName: string; toolUseId?: string };

/** Trim newlines + collapse whitespace, then clamp to TEXT_PREVIEW_MAX. */
function trimTextPreview(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return truncate(collapsed, TEXT_PREVIEW_MAX);
}

/**
 * "Reading <domain>" text for a `web_fetch` step (rendered as a `thinking`
 * step, exactly as main chat does — see `buildWebFetchStep`). Prefers the raw
 * `url` from the preserved input, else the event `content` summary (which is
 * the URL for `web_fetch` — `url` is a `TOOL_INPUT_PRIORITY_KEYS` member).
 * Delegates hostname extraction (+ `www.` stripping) to the shared
 * `extractDomain`. Falls back to "Reading…" when nothing usable is present,
 * mirroring the main-chat placeholder.
 */
function webFetchReadingText(event: SubagentTimelineEvent): string {
  const fromInput =
    event.input && typeof event.input.url === "string" ? event.input.url : "";
  const raw = (fromInput || event.content || "").trim();
  const domain = raw ? extractDomain(raw) : "";
  return domain ? `Reading ${domain}` : "Reading…";
}

/**
 * Duration label for a tool / web step from its start + end timestamps.
 * Returns "" for an unknown or non-positive delta: `mapDetailEvents` stamps
 * every fetched-history event with the same `Date.now()`, so a matched
 * `tool_call`→`tool_result` delta is exactly 0 and `formatMs(0)` would render a
 * misleading "<1s" for every historical run. Real streaming events carry
 * distinct receive-time values (delta > 0), so genuine sub-second tools still
 * show "<1s" — only the synthetic equal-timestamp case is dropped.
 */
function durationLabelBetween(
  startTs: number | undefined,
  endTs: number,
): string {
  const delta =
    typeof startTs === "number" && Number.isFinite(startTs)
      ? endTs - startTs
      : 0;
  return delta > 0 ? formatMs(delta) : "";
}

/**
 * Build a `web_search_error` step from a failed web-search follow-up. Shared by
 * the `tool_result` and `error` branches (a failed web search can arrive as
 * either type). Distinct from the exported `buildWebSearchErrorStep` in
 * `tool-call-card-utils`, which builds from the rich `ToolActivityMetadata` the
 * subagent timeline doesn't carry.
 */
function webSearchErrorStep(
  durationLabel: string,
  event: SubagentTimelineEvent,
): Extract<ToolCallCardStep, { kind: "web_search_error" }> {
  return {
    kind: "web_search_error",
    title: "Web search failed",
    durationLabel,
    errorMessage:
      trimTextPreview(event.result ?? event.content) || "Web search failed",
    // Key the chip to its tool id so the timeline pill opens the nested detail
    // (the full, untruncated error) — matching the failed web_search payload
    // `buildSubagentStepDetails` keeps under the same id.
    detailKey: event.toolUseId,
  };
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
      // Fallback only: the summary lacks the editor sub-command, so route
      // through "Editing" by default (safer than mis-classifying a write as a
      // read). Callers prefer the raw `event.input` (which carries `command`)
      // and only reach this when it's absent.
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
 * `sparkle` for skills, etc.) rather than always rendering `bolt` / generic
 * "Using <Tool>" labels. Derives from the raw `event.input` when present,
 * falling back to `reconstructInputBag(content)` only for older events that
 * lack it.
 *
 * `toolCallId` mirrors `toolUseId` so the renderer key + result matcher
 * have a stable identifier.
 */
export function mapToolEventToStep(
  event: SubagentTimelineEvent,
): Extract<ToolCallCardStep, { kind: "tool" }> {
  const toolName = event.toolName ?? "";
  const content = event.content ?? "";
  // Prefer the raw `input` (now preserved on the event) over the lossy
  // `reconstructInputBag(content)` fallback — the summary `content` keeps only a
  // single `TOOL_INPUT_PRIORITY_KEYS` field and never the `activity` sentence,
  // so deriving from it drops skill names, computer actions, and the rich
  // activity label. Mirrors `buildSubagentStepDetails` so the timeline pill and
  // the nested detail view agree.
  const input = event.input ?? reconstructInputBag(toolName, content);
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
 * Core in-flight matching predicate, shared by `findMatchingInFlightToolIndex`
 * (which drives `computeSubagentCardData`) and `buildSubagentStepDetails` so
 * the two projections can't drift. Walks `candidates` newest-first and returns
 * the index of the first still-`running` tool that matches the follow-up
 * `event`. Match precedence:
 *   1. Exact `toolUseId` match — required when the event carries one (so
 *      parallel calls to the same tool don't bleed into each other).
 *   2. `toolName` match against the originating `tool_call`'s name.
 *   3. "Latest in-flight" — when neither identifier is present.
 *
 * Returns -1 when no in-flight candidate matches.
 */
function matchInFlightTool(
  candidates: Array<{ toolCallId: string; toolName: string; running: boolean }>,
  event: { toolUseId?: string; toolName?: string },
): number {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (!candidate.running) continue;
    if (event.toolUseId) {
      if (candidate.toolCallId === event.toolUseId) return i;
      // Exact-match-only when the event carries a toolUseId — do NOT fall
      // through to toolName matching for a different ID.
      continue;
    }
    if (!event.toolName || candidate.toolName === event.toolName) return i;
  }
  return -1;
}

/**
 * Find the index of the most recent in-flight tool step that matches a
 * follow-up event (`tool_result` or `error`). Thin adapter over
 * `matchInFlightTool` projecting the `(steps, toolMeta)` parallel arrays into
 * the shared candidate shape.
 *
 * Returns -1 when no in-flight step matches.
 */
function findMatchingInFlightToolIndex(
  steps: ToolCallCardStep[],
  toolMeta: Array<ToolMeta | undefined>,
  event: { toolUseId?: string; toolName?: string },
): number {
  return matchInFlightTool(
    steps.map((step, i) => {
      const meta = toolMeta[i];
      if (step.kind === "tool") {
        return {
          toolCallId: step.toolCallId,
          toolName: meta?.toolName ?? "",
          running: step.status === "running",
        };
      }
      // A `web_search` step carries no id on its shape, so its `toolUseId` is
      // tracked in `toolMeta`. It's in-flight while its title is still the
      // present-tense placeholder; the `tool_result`/`error` follow-up flips it
      // to past tense (or a `web_search_error`).
      if (step.kind === "web_search") {
        return {
          toolCallId: meta?.toolUseId ?? "",
          toolName: meta?.toolName ?? "",
          running: step.title === "Searching the web",
        };
      }
      return { toolCallId: "", toolName: meta?.toolName ?? "", running: false };
    }),
    event,
  );
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
    case "interrupted":
      return "error";
    default:
      return "loading";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure per-event reducer for the timeline projection: mutates the parallel
 * `(steps, toolMeta)` arrays in place exactly as a single iteration of
 * `computeSubagentSteps`'s loop. The shared step-folding logic so an
 * incremental replay can't drift from the full rebuild. No-op for unhandled
 * event types.
 */
export function applyTimelineEvent(
  steps: ToolCallCardStep[],
  toolMeta: Array<ToolMeta | undefined>,
  event: SubagentTimelineEvent,
): void {
  if (event.type === "text") {
    const text = trimTextPreview(event.content);
    // Skip empty text events — they'd render as a blank thinking step.
    if (text.length === 0) return;
    // `detailKey` (the source event id) lets the timeline pill open the full,
    // un-truncated reasoning via `buildSubagentStepDetails` — the pill itself
    // only carries the collapsed `text` preview.
    steps.push({ kind: "thinking", durationLabel: "", text, detailKey: event.id });
    toolMeta.push(undefined);
    return;
  }

  if (event.type === "tool_call") {
    const toolName = event.toolName ?? "";
    // Route web tools to the dedicated step kinds so their phase labels match
    // main chat ("Searching the web" / "Thinking") instead of the generic
    // "Working" bucket the tool path produces. Mirrors the main-chat split in
    // `tool-call-card-utils` (`buildWebSearchStep` / `buildWebFetchStep`).
    if (WEB_TOOL_NAMES.has(toolName)) {
      if (toolName === "web_fetch") {
        // `web_fetch` renders as a "Reading <domain>" thinking step — no
        // follow-up tracking needed (the domain is known at call time, and a
        // thinking step is neutral for phase status).
        steps.push({
          kind: "thinking",
          durationLabel: "",
          text: webFetchReadingText(event),
          // Key the step to its tool id so the timeline pill opens the nested
          // web_fetch detail (source card + extracted content) — matching the
          // `toolUseId`-keyed payload `buildSubagentStepDetails` emits, the
          // same way the `web_search` branch below keys its pill.
          detailKey: event.toolUseId,
        });
        toolMeta.push(undefined);
      } else {
        // `web_search` — placeholder until its result lands; the matched
        // `tool_result` flips the title tense + fills in results (see below).
        // `query` (raw input, else the `content` summary which is the query
        // for web_search) labels the step so unclamped multi-search groups
        // stay distinct in the timeline; it survives the `...target` spread on
        // completion.
        const query =
          event.input && typeof event.input.query === "string"
            ? event.input.query
            : event.content || undefined;
        steps.push({
          kind: "web_search",
          query,
          title: "Searching the web",
          durationLabel: "",
          linkCount: 0,
          results: [],
          // The originating tool id keys this search's nested detail so the
          // timeline can render it as a clickable pill (query + sources) —
          // matches the key `buildSubagentStepDetails` emits. Survives the
          // `...target` spread on completion alongside `query`.
          detailKey: event.toolUseId,
        });
        toolMeta.push({
          startTs: event.timestamp,
          toolName,
          toolUseId: event.toolUseId,
        });
      }
      return;
    }
    steps.push(mapToolEventToStep(event));
    toolMeta.push({ startTs: event.timestamp, toolName });
    return;
  }

  if (event.type === "tool_result") {
    const matchIndex = findMatchingInFlightToolIndex(steps, toolMeta, event);
    if (matchIndex === -1) return;
    const target = steps[matchIndex]!;
    const start = toolMeta[matchIndex]?.startTs;
    const durationLabel = durationLabelBetween(start, event.timestamp);
    // `web_search` signals completion via title tense (not a `status` field):
    // success flips "Searching" → "Searched"; an error becomes a
    // `web_search_error` step (both still group under "Searching the web").
    if (target.kind === "web_search") {
      if (event.isError) {
        steps[matchIndex] = webSearchErrorStep(durationLabel, event);
        return;
      }
      // Parse the result text (Title\nURL pairs) into link chips — the same
      // fallback main chat uses on reload, since the subagent timeline carries
      // the raw result text but not the structured `activityMetadata`. No
      // clamp: the detail panel has room to show every source inline, so all
      // results go in `results` and `overflowResults` stays empty.
      const results = parseWebSearchResultText(event.result ?? event.content);
      steps[matchIndex] = {
        ...target,
        title: "Searched the web",
        // Backfill the query from the result's metadata. The originating
        // `tool_call` carried empty input live (Anthropic resolves web_search
        // input only at completion), so `target.query` is usually undefined
        // until this result lands `searchQuery`. The history/detail path
        // already has it on the call, hence the `target.query ||` precedence.
        query: target.query || event.searchQuery,
        durationLabel,
        linkCount: results.length,
        results,
      };
      return;
    }
    if (target.kind !== "tool") return;
    steps[matchIndex] = {
      ...target,
      status: event.isError ? "error" : "completed",
      durationLabel,
    };
    return;
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
      } else if (target.kind === "web_search") {
        steps[matchIndex] = webSearchErrorStep(
          durationLabelBetween(toolMeta[matchIndex]?.startTs, event.timestamp),
          event,
        );
      }
    }
    const message = trimTextPreview(event.content) || "Subagent error";
    steps.push({ kind: "tool_error", message });
    toolMeta.push(undefined);
    return;
  }
}

/**
 * Build the `(steps, toolMeta)` parallel arrays for a subagent's full event
 * list by folding `applyTimelineEvent` over each event. The single source of
 * truth for the timeline projection's step state, consumed by
 * `computeSubagentCardData`.
 */
export function computeSubagentSteps(events: SubagentTimelineEvent[]): {
  steps: ToolCallCardStep[];
  toolMeta: Array<ToolMeta | undefined>;
} {
  const steps: ToolCallCardStep[] = [];
  // Parallel array tracking per-step metadata not carried on the shared step
  // shapes (see `ToolMeta`). Indexed by `steps` position; `undefined` for
  // entries with no follow-up (thinking, tool_error, web_fetch).
  const toolMeta: Array<ToolMeta | undefined> = [];

  for (const event of events) applyTimelineEvent(steps, toolMeta, event);

  return { steps, toolMeta };
}

/**
 * Pure projection of (entry) → card props. Split from the hook so tests
 * can drive it without instantiating the Zustand store.
 *
 * The heavy O(n) timeline walk is isolated in `computeSubagentSteps` so callers
 * that re-render on every status/usage tick — like `subagent-detail-panel.tsx`,
 * which renders its own header from `entry` and consumes only `steps` — can
 * memoize the walk on `entry.events` (reference-stable across those ticks)
 * rather than re-running it here on every `entry` identity bump.
 */
export function computeSubagentCardData(
  entry: SubagentEntry,
): ToolCallCardData {
  return deriveSubagentCardData(entry, computeSubagentSteps(entry.events));
}

/**
 * The cheap O(1) tail of `computeSubagentCardData`: given an entry and an
 * already-projected `{ steps, toolMeta }`, derive the carousel meta (state,
 * current-step title/info, step count) and assemble the card props. Split out so
 * `useSubagentCardData` can feed it the incremental projector's output instead
 * of re-walking the timeline. Reads only the last step, so it's safe to run on
 * every render.
 */
export function deriveSubagentCardData(
  entry: SubagentEntry,
  { steps, toolMeta }: { steps: ToolCallCardStep[]; toolMeta: Array<ToolMeta | undefined> },
): ToolCallCardData {
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
  toolMeta: Array<ToolMeta | undefined>,
): { currentStepTitle: string; currentStepInfo: string } {
  const isTerminal =
    entry.status === "completed" ||
    entry.status === "failed" ||
    entry.status === "aborted" ||
    entry.status === "interrupted";

  if (steps.length === 0) {
    // Branch on the actual terminal status so a subagent that failed, aborted,
    // or was interrupted before emitting any events doesn't read as "Finished".
    let title: string;
    if (entry.status === "failed") title = "Failed";
    else if (entry.status === "aborted") title = "Aborted";
    else if (entry.status === "interrupted") title = "Interrupted";
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

  if (latest.kind === "web_search") {
    // Title already carries the tense ("Searching the web" / "Searched the
    // web"), set at call time and flipped on the matched result.
    return { currentStepTitle: latest.title, currentStepInfo: "" };
  }

  if (latest.kind === "web_search_error") {
    return {
      currentStepTitle: latest.title,
      currentStepInfo: latest.errorMessage,
    };
  }

  // Every step kind is handled above; this neutral return only satisfies the
  // exhaustive-union check.
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
  // Project incrementally (must run unconditionally — `useSubagentSteps` holds
  // a ref). In the spawn-race window there's no entry yet, so feed the stable
  // empty array; the `null` return below preserves the existing contract.
  const projected = useSubagentSteps(entry?.events ?? EMPTY_EVENTS);

  const lastRef = useRef<ToolCallCardData | null>(null);

  // Intentional render-phase ref usage: `lastRef` caches the last projected
  // card so we can preserve its identity across renders that produce an equal
  // result (so the inline card's `React.memo` bails). Same pattern as
  // `useSubagentSteps` / `use-event-stream.ts`.
  /* eslint-disable react-hooks/refs -- per-instance card-identity cache (see above) */
  if (!entry) {
    lastRef.current = null;
    return null;
  }

  const next = deriveSubagentCardData(entry, projected);
  const last = lastRef.current;
  // Preserve `cardData` identity when the projected steps and the cheap meta
  // scalars are all unchanged, so the inline card's `React.memo` / shell bails.
  // `toolMeta`/`carouselItems` aren't read downstream; comparing `steps`
  // identity (stable across no-op deltas) plus the derived scalars is sufficient.
  if (
    last != null &&
    last.steps === next.steps &&
    last.state === next.state &&
    last.currentStepTitle === next.currentStepTitle &&
    last.currentStepInfo === next.currentStepInfo &&
    last.stepCount === next.stepCount
  ) {
    return last;
  }
  lastRef.current = next;
  return next;
  /* eslint-enable react-hooks/refs */
}

/**
 * Pure projection of (entry) → a map of nested detail payloads, keyed by the
 * id a clickable timeline pill emits. Separate from `computeSubagentCardData`
 * (whose `ToolCallCardStep`s carry only label/duration + a truncated text
 * preview, not the raw `input`/`result` or full reasoning) so the pills can
 * open the full detail view:
 *  - tool steps → `ToolDetailBody` (technical details + output), keyed by
 *    `toolUseId`; `tool_call` events with an empty id are skipped.
 *  - text/thinking steps → a `kind: "thinking"` payload carrying the FULL,
 *    un-truncated reasoning markdown, keyed by the text event's id (matching
 *    the `detailKey` `computeSubagentCardData` stamps on the thinking step).
 *  - web_search steps → a `kind: "web_search"` payload carrying the query +
 *    the parsed result sources, keyed by `toolUseId` (matching the `detailKey`
 *    `computeSubagentCardData` stamps on the search step).
 *
 * Walks `events` in order, tracking in-flight tool payloads and resolving
 * `tool_result` / `error` follow-ups against them with `matchInFlightTool` —
 * the same precedence `computeSubagentCardData` uses, so the two stay aligned.
 * Risk fields (`riskLevel`/`riskReason`) are omitted — subagent timeline events
 * don't carry them.
 */
/**
 * Pure per-event reducer for the detail-map projection: mutates the parallel
 * `(payloads, meta)` arrays in place exactly as a single iteration of
 * `buildSubagentStepDetails`'s loop. The detail-map counterpart to
 * `applyTimelineEvent` so an incremental replay folds through the same logic.
 * No-op for unhandled event types.
 */
export function applyDetailEvent(
  payloads: ToolDetailPayload[],
  meta: Array<{ startTs: number; running: boolean }>,
  event: SubagentTimelineEvent,
): void {
  // Text events become clickable "thinking" pills. Carry the FULL content
  // (the timeline pill shows only a collapsed preview) and key by the event
  // id to match the step's `detailKey`. Skip whitespace-only text exactly as
  // `computeSubagentCardData` does so steps and payloads stay aligned.
  if (event.type === "text") {
    if ((event.content ?? "").trim().length === 0) return;
    payloads.push({
      toolCallId: event.id,
      toolName: "",
      title: "Thought",
      activity: "",
      input: {},
      status: "completed",
      durationLabel: "",
      kind: "thinking",
      thinkingText: event.content,
    });
    meta.push({ startTs: event.timestamp, running: false });
    return;
  }

  if (event.type === "tool_call") {
    const toolCallId = event.toolUseId ?? "";
    // Skip calls without an id — they can't be keyed or clicked.
    if (!toolCallId) return;
    const toolName = event.toolName ?? "";
    // Web search → a dedicated detail payload carrying the query and (once the
    // result lands) the parsed source list, rendered as favicon chips rather
    // than the raw technical-details body. Mirrors the `web_search` step the
    // timeline projection builds, keyed by the same `toolUseId`.
    if (toolName === "web_search") {
      const query =
        event.input && typeof event.input.query === "string"
          ? event.input.query
          : event.content || undefined;
      payloads.push({
        toolCallId,
        toolName,
        title: "Searched the web",
        activity: "",
        input: event.input ?? {},
        status: "running",
        durationLabel: "",
        kind: "web_search",
        searchQuery: query,
        searchResults: [],
      });
      meta.push({ startTs: event.timestamp, running: true });
      return;
    }
    const labelInput =
      event.input ?? reconstructInputBag(toolName, event.content ?? "");
    const label = deriveStepLabelFromName(toolName, labelInput);
    payloads.push({
      toolCallId,
      toolName,
      title: label.title,
      activity: label.activity,
      input: event.input ?? {},
      status: "running",
      durationLabel: "",
      kind: "tool",
    });
    meta.push({ startTs: event.timestamp, running: true });
    return;
  }

  // A follow-up carrying a result. A FAILED tool result is mapped to a raw
  // `error`-typed event (see `mapInnerEventType`) yet still carries its
  // `result` + `isError`, so we resolve both `tool_result` and `error`
  // against the in-flight list regardless of the mapped type.
  if (event.type === "tool_result" || event.type === "error") {
    const matchIndex = matchInFlightTool(
      payloads.map((payload, i) => ({
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        running: meta[i]!.running,
      })),
      event,
    );
    if (matchIndex === -1) return;
    const target = payloads[matchIndex]!;
    const start = meta[matchIndex]!.startTs;
    // Shared with `computeSubagentCardData` so the non-positive-delta
    // suppression (synthetic equal-timestamp history events → "") can't drift
    // between the two projections.
    const durationLabel = durationLabelBetween(start, event.timestamp);
    // Web search → parse the raw result text into the same source chips the
    // timeline renders; everything else keeps the raw `result` for the
    // technical-details body.
    payloads[matchIndex] =
      target.kind === "web_search"
        ? {
            ...target,
            status: event.isError ? "error" : "completed",
            durationLabel,
            // Backfill the query from the result metadata for the nested
            // detail view — the call-time `searchQuery` is empty live (see
            // the timeline projection's matching backfill).
            searchQuery: target.searchQuery || event.searchQuery,
            searchResults: event.isError
              ? []
              : parseWebSearchResultText(event.result ?? event.content),
            // On failure, keep the full provider/backend error so the nested
            // detail can show it untruncated — the timeline chip only carries
            // a `trimTextPreview` snippet. Parity with how a failed tool keeps
            // its full `result`.
            result: event.isError
              ? (event.result ?? event.content)
              : undefined,
          }
        : {
            ...target,
            result: event.result ?? event.content,
            status: event.isError ? "error" : "completed",
            durationLabel,
          };
    meta[matchIndex]!.running = false;
  }
}

export function buildSubagentStepDetails(
  events: SubagentTimelineEvent[],
): Map<string, ToolDetailPayload> {
  const payloads: ToolDetailPayload[] = [];
  // Parallel array: start timestamp + running flag per payload, used for
  // matching follow-ups and duration calc. Indexed by `payloads` position.
  const meta: Array<{ startTs: number; running: boolean }> = [];

  for (const event of events) applyDetailEvent(payloads, meta, event);

  // Every payload (including a failed web_search) is kept and keyed by its tool
  // id. The timeline's `web_search_error` step carries the same id as its
  // `detailKey`, so clicking the failed-search chip opens this payload's full,
  // untruncated error — parity with a failed tool.
  return new Map(payloads.map((payload) => [payload.toolCallId, payload]));
}
