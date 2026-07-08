/** Pure projection and helpers for the unified tool-call progress card.
 *
 *  Separated from the React hook (`useToolCallCardData`) so they can be
 *  unit-tested without React context plumbing. The hook wires these into the
 *  Zustand turn store; these functions own the data mapping. */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolDetailPayload } from "@/stores/viewer-store";
import {
  isToolCallRunning,
  perceivedStartedAt,
} from "@/domains/chat/utils/tool-call-status";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types";
import {
  deriveStepLabel,
  type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { isSubagentSpawnCall } from "@/domains/chat/transcript/message-content";
import {
  extractDomain,
  parseWebSearchResultText,
} from "@/domains/chat/utils/web-search-result-text";

/** Max favicon chips to render inside a single `web_search` step row. */
const MAX_VISIBLE_RESULTS = 5;

/**
 * Friendly fallback copy for a `web_search` backend failure when the daemon
 * omits `webSearch.errorMessage`. clients/web CANNOT import from `assistant/`, so
 * this is a local mirror — keep in sync with WEB_SEARCH_BACKEND_FAILURE_MESSAGE
 * in assistant/src/tools/network/web-search-error.ts.
 */
export const WEB_SEARCH_BACKEND_FAILURE_MESSAGE =
  "Search is having trouble right now. You can try again in a moment, continue without web search, or paste the relevant details here and I'll use those.";

/** Tool names whose presence triggers the web-search step path. */
export const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

/**
 * Discriminated step descriptor for the unified tool-call progress card.
 *
 * The first three variants (`thinking`, `web_search`, `web_search_error`)
 * cover the web-search rendering path. The `tool` variant carries the
 * title/info/icon tuple produced by
 * `deriveStepLabel` plus the per-call duration + status fields the unified
 * card needs to drive its row chrome. The `tool_error` variant is used by
 * `useSubagentCardData` for synthesised terminal-error events that have
 * no preceding `tool_call` (e.g. context-window blowouts surfaced via
 * the subagent timeline's `error` event type).
 */
export type ToolCallCardStep =
  | {
      kind: "thinking";
      durationLabel: string;
      text: string;
      /**
       * Epoch-ms start of the reasoning run, when known. Mirrors the `tool`
       * variant's `startedAt`: surfaced as a tooltip on the phase duration so
       * hovering "3s" reveals when the reasoning began. Omitted when the daemon
       * didn't stamp the thinking block.
       */
      startedAt?: number;
      /** Epoch-ms end of the reasoning run, when known. */
      completedAt?: number;
      /**
       * Ordinal of this reasoning segment among the group's GENUINE thinking
       * items (0-based, in render order). Carried into the drawer payload so the
       * open panel re-derives this exact segment's live text. Omitted for
       * web-synthesized thinking steps (e.g. `web_fetch` "Reading …"), which
       * have no backing reasoning item and keep the snapshot path.
       */
      thinkingItemIndex?: number;
      /**
       * Opaque key into a parent-built detail-payload map, letting a clickable
       * thinking pill open its full reasoning in a detail view. Set by the
       * subagent timeline (the source text event's id); unset elsewhere, where
       * thinking pills stay non-interactive.
       */
      detailKey?: string;
    }
  | {
      kind: "web_search";
      title: string;
      /**
       * The search query, when known. Surfaced by the subagent timeline as a
       * per-step label so multiple unclamped searches in one "Searching the web"
       * group stay visually distinct; main-chat builders leave it unset.
       */
      query?: string;
      durationLabel: string;
      linkCount: number;
      /** Results shown inline as favicon chips (clamped to `MAX_VISIBLE_RESULTS`). */
      results: WebSearchResultItem[];
      /**
       * Results beyond the visible clamp. Surfaced behind the `+N more`
       * overflow pill so the additional sources remain reachable. Empty or
       * omitted when every result fits inline.
       */
      overflowResults?: WebSearchResultItem[];
      /**
       * Stable key (the originating `tool_call`'s `toolUseId`) that lets the
       * subagent timeline render this search as a clickable pill opening its
       * nested query + sources detail — matching the key
       * `buildSubagentStepDetails` emits. Unset for main-chat builders, whose
       * searches aren't clickable.
       */
      detailKey?: string;
    }
  | {
      kind: "web_search_error";
      title: string;
      durationLabel: string;
      errorMessage: string;
      /**
       * Detail-map key (the failed search's tool id) so the timeline error chip
       * opens the full, untruncated error in a nested detail. `undefined` when
       * the failed search carried no tool id (chip stays non-clickable).
       */
      detailKey?: string;
    }
  | {
      kind: "tool";
      durationLabel: string;
      /**
       * Epoch-ms start time of the call (`tc.startedAt`), when known. Surfaced
       * as a tooltip on the phase duration so hovering "3s" reveals when the
       * work began. Omitted when the daemon didn't stamp a start time.
       */
      startedAt?: number;
      title: string;
      info: string;
      /**
       * Rich, human-readable activity sentence (from `StepLabel.activity`).
       * Preferred display text for the pill/drawer; `info` is the terse
       * fallback used when no activity sentence is present.
       */
      activity: string;
      /** Daemon-assigned risk level for the call (e.g. `"low"`), when present. */
      riskLevel?: string;
      iconName: IconName;
      toolCallId: string;
      status: "running" | "completed" | "error" | "denied";
    }
  | { kind: "tool_error"; message: string };

/**
 * Card-level data for the unified tool-call progress card.
 *
 * `steps` is a `ToolCallCardStep[]` that covers web and non-web tools alike.
 * `state` widens to include `"error"` / `"denied"` so cards that mix
 * successful and failed tool calls can render a distinct chrome state.
 *
 * The subagent leading-icon slot (`<SubagentAvatarChip>`) is plumbed directly
 * through the inline card's `leadingIcon` ReactNode prop by the subagent
 * descriptor's `renderCardLeading`, so this data shape doesn't need to carry it.
 */
export interface ToolCallCardData {
  /**
   * Title text rendered in the collapsed header. Reflects the most recent
   * step's title (e.g. "Searching the web" → "Searched the web") so the
   * header carousels through each step's tense as the turn progresses.
   */
  currentStepTitle: string;
  /**
   * Per-step gray subtext rendered after the title. Animates alongside
   * `currentStepTitle` via the card's throttled carousel. See the
   * per-kind table in `deriveCurrentStepInfo`.
   */
  currentStepInfo: string;
  /**
   * Kind of the latest step driving the header. `"thinking"` when the run's
   * last built step is a thinking segment (so the card can render a brain
   * glyph beside `currentStepInfo`); `"tool"` otherwise. Optional so other
   * `ToolCallCardData` constructors/consumers are unaffected.
   */
  currentStepKind?: "thinking" | "tool";
  /** Pre-formatted step count, e.g. `"2 steps"`. */
  stepCount: string;
  /**
   * Total active work time across the group's tool calls (sum of per-call
   * durations), formatted like `"16s"`. Empty when no call carries timing data
   * or the total is sub-second. Drives the expanded card's "Worked for Xs"
   * header summary. Optional so other `ToolCallCardData` constructors (e.g. the
   * subagent card) are unaffected.
   */
  totalDurationLabel?: string;
  /** Ordered sub-steps to render when expanded. */
  steps: ToolCallCardStep[];
  /**
   * Card-wide visual state:
   * - `"loading"` while any tool call is still running.
   * - `"denied"` when any tool call was denied via `confirmationDecision`.
   * - `"error"` when at least one tool ended in `status === "error"` and no
   *   tool is still running.
   * - `"complete"` once every tool call has reached a terminal status.
   */
  state: "loading" | "complete" | "error" | "denied";
  /** Results to feed the collapsed-header rotating carousel (web-search only). */
  carouselItems: WebSearchResultItem[];
}

// ---------------------------------------------------------------------------
// Small pure helpers used by the unified card hook and its consumers.
// ---------------------------------------------------------------------------

/**
 * Format a duration in ms for the row-meta cluster as a single, human-readable
 * unit with low precision — seconds for short work, then minutes, then hours
 * as the run gets longer (`<1s`, `2s`, `45s`, `3m`, `2h`). We round to the
 * coarsest unit and drop the smaller one (a "long enough task" reads as `3m`,
 * not `3m 12s`) so the label stays glanceable in the card header and chips.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** True when `tc.name` is a web tool (`web_search` / `web_fetch`). */
function isWebTool(tc: ChatMessageToolCall): boolean {
  return WEB_TOOL_NAMES.has(tc.name);
}

/**
 * Decide the StepRow label for a `web_search` row. Past-tense once the
 * underlying tool call is terminal so a completed turn doesn't read as if
 * the search is still in flight.
 */
function webSearchStepTitle(terminal: boolean): string {
  return terminal ? "Searched the web" : "Searching the web";
}

function clampResults(results: WebSearchResultItem[]): {
  visible: WebSearchResultItem[];
  overflowResults: WebSearchResultItem[];
} {
  return {
    visible: results.slice(0, MAX_VISIBLE_RESULTS),
    overflowResults: results.slice(MAX_VISIBLE_RESULTS),
  };
}

function buildWebSearchStep(
  metadata: NonNullable<ToolActivityMetadata["webSearch"]>,
  terminal: boolean,
): ToolCallCardStep {
  const { visible, overflowResults } = clampResults(metadata.results);
  return {
    kind: "web_search",
    title: webSearchStepTitle(terminal),
    durationLabel: formatMs(metadata.durationMs),
    linkCount: metadata.resultCount,
    results: visible,
    overflowResults,
  };
}

function buildWebFetchStep(
  metadata: NonNullable<ToolActivityMetadata["webFetch"]>,
): ToolCallCardStep {
  const label = metadata.title ?? metadata.domain;
  return {
    kind: "thinking",
    durationLabel: formatMs(metadata.durationMs),
    text: `Reading ${label}`,
  };
}

function buildWebSearchPlaceholderStep(): ToolCallCardStep {
  return {
    kind: "web_search",
    title: "Searching the web",
    durationLabel: "",
    linkCount: 0,
    results: [],
  };
}

function buildWebFetchPlaceholderStep(): ToolCallCardStep {
  return { kind: "thinking", durationLabel: "", text: "Reading…" };
}

function buildWebSearchStepFromResultText(
  text: string,
): (ToolCallCardStep & { kind: "web_search" }) | null {
  const parsed = parseWebSearchResultText(text);
  if (parsed.length === 0) return null;
  const { visible, overflowResults } = clampResults(parsed);
  return {
    kind: "web_search",
    title: webSearchStepTitle(true),
    durationLabel: "",
    linkCount: parsed.length,
    results: visible,
    overflowResults,
  };
}

export function buildWebSearchErrorStep(
  metadata: NonNullable<ToolActivityMetadata["webSearch"]>,
): ToolCallCardStep {
  return {
    kind: "web_search_error",
    title: "Web search failed",
    durationLabel: formatMs(metadata.durationMs),
    errorMessage: metadata.errorMessage ?? WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
  };
}

function buildEmptyWebSearchStep(): ToolCallCardStep {
  return {
    kind: "web_search",
    title: webSearchStepTitle(true),
    durationLabel: "",
    linkCount: 0,
    results: [],
  };
}

function resolveMetadata(
  tc: ChatMessageToolCall,
  liveWebActivity: Record<string, ToolActivityMetadata>,
): ToolActivityMetadata | undefined {
  return liveWebActivity[tc.id] ?? tc.activityMetadata;
}

function isTerminalStatus(tc: ChatMessageToolCall): boolean {
  return !isToolCallRunning(tc);
}

/**
 * Classify a `web_search` whose metadata carried zero results as a *failure*
 * (vs. a successful `no_results` search).
 *
 * The backend is the single centralization point and sets
 * `webSearch.errorMessage` on every genuine failure (see
 * `errorResult` in assistant/src/tools/network/web-search.ts), so a present
 * `errorMessage` is the primary signal. As defensive depth for the case where
 * the daemon ever omits that message on a failed search, we also treat the
 * tool call's own terminal `status === "error"` (mapped from the tool_result
 * `isError` flag in `applyToolResult`) as a failure signal.
 *
 * Crucially, a successful empty/`no_results` search lands as
 * `status === "completed"` with no `errorMessage`, so it is NOT classified as
 * a failure — ATL-727's core invariant (empty-but-successful must not render
 * as a failure) is preserved.
 */
function isFailedEmptyWebSearch(
  ws: NonNullable<ToolActivityMetadata["webSearch"]>,
  tc: ChatMessageToolCall,
): boolean {
  if (ws.results.length > 0) return false;
  return Boolean(ws.errorMessage) || Boolean(tc.isError);
}

/**
 * Map a tool call's `confirmationDecision` + `status` to the unified card's
 * narrowed step-status enum. `"denied"` precedence beats both `"error"` and
 * `"completed"` so the denied chrome stays visible after the daemon
 * eventually stamps an error tool_result for the same call.
 */
function deriveToolStepStatus(
  tc: ChatMessageToolCall,
): "running" | "completed" | "error" | "denied" {
  if (
    tc.confirmationDecision === "denied" ||
    tc.confirmationDecision === "timed_out"
  ) {
    return "denied";
  }
  if (tc.isError) {
    return "error";
  }
  return isToolCallRunning(tc) ? "running" : "completed";
}

/**
 * Raw duration in ms between a start and completion epoch. Returns `null` when
 * either bound is missing so callers can distinguish "no data" from a genuine
 * `0ms`. Shared by tool and thinking steps so both derive durations identically.
 */
function computeDurationMs(
  startedAt: number | undefined,
  completedAt: number | undefined,
): number | null {
  if (startedAt == null || completedAt == null) return null;
  return Math.max(0, completedAt - startedAt);
}

/**
 * Duration label from a start/completion epoch pair, mirroring the legacy
 * generic card: `formatMs(completedAt - startedAt)`. Returns an empty string
 * when timings are missing so the row chrome can hide the meta cluster rather
 * than render a misleading `<1s`.
 */
function computeDurationLabel(
  startedAt: number | undefined,
  completedAt: number | undefined,
): string {
  const ms = computeDurationMs(startedAt, completedAt);
  return ms == null ? "" : formatMs(ms);
}

function computeToolDurationLabel(tc: ChatMessageToolCall): string {
  return computeDurationLabel(
    tc.startedAt ?? undefined,
    tc.completedAt ?? undefined,
  );
}

/** True for a tool call that is rendered as a step AND still in flight. */
function isRenderableRunningCall(tc: ChatMessageToolCall): boolean {
  return !isSubagentSpawnCall(tc) && isToolCallRunning(tc);
}

/**
 * Raw active-work duration in ms for a single ordered item — the building
 * block of the header's "Worked for Xs" / "Working for Xs" total. Sums BOTH
 * thinking and tool time so the header reflects everything the run grouped,
 * not just its tool calls.
 *
 * For an in-flight step (a running tool call, or a thinking segment that has
 * started but not yet finished) the elapsed is measured against `nowMs` when
 * supplied, so the total ticks upward during streaming. Without `nowMs` an
 * unfinished step contributes nothing (the caller is at rest). Returns `null`
 * for items that carry no usable timing or aren't rendered as steps (empty
 * thinking, `subagent_spawn`) so the caller can distinguish "no data".
 */
function computeItemDurationMs(
  item: ToolCallCardItem,
  nowMs: number | undefined,
): number | null {
  if (item.kind === "thinking") {
    if (!item.text) return null;
    if (item.completedAt != null) {
      return computeDurationMs(item.startedAt, item.completedAt);
    }
    if (item.startedAt != null && nowMs != null) {
      return Math.max(0, nowMs - item.startedAt);
    }
    return null;
  }
  const tc = item.toolCall;
  if (isSubagentSpawnCall(tc)) return null;
  // The header total is the user-perceived "time they feel", so it anchors on
  // the first-byte `previewStartedAt` (falling back to execution start) rather
  // than `tc.startedAt`. This includes the input-streaming gap before the tool
  // actually runs. The per-step rows still show the tool's own execution
  // latency via `computeToolDurationLabel`.
  const perceived = perceivedStartedAt(tc);
  if (tc.completedAt != null)
    return computeDurationMs(perceived, tc.completedAt);
  if (isToolCallRunning(tc) && perceived != null && nowMs != null) {
    return Math.max(0, nowMs - perceived);
  }
  return null;
}

/**
 * True when any ordered item is still in flight — a running (non-spawn) tool
 * call, or a thinking segment that has started but not completed. The card
 * hook uses this to decide whether to drive the per-second clock that makes
 * the header's "Working for Xs" total tick during streaming.
 */
export function hasRunningItem(items: ToolCallCardItem[]): boolean {
  return items.some((item) =>
    item.kind === "thinking"
      ? Boolean(item.text) && item.startedAt != null && item.completedAt == null
      : isRenderableRunningCall(item.toolCall),
  );
}

/**
 * Total active work time across a group's steps — the sum of each thinking and
 * tool step's raw duration — formatted via `formatMs` (so a sub-second total
 * reads `<1s`, matching the per-phase duration chips). Powers the expanded
 * card's "Worked for Xs" / "Working for Xs" summary; when `nowMs` is supplied
 * the still-running step's elapsed is included so the total ticks during
 * streaming. Returns an empty string only when NO step carries timing data, in
 * which case the header falls back to its outcome label.
 */
function computeTotalDurationLabel(
  items: ToolCallCardItem[],
  nowMs: number | undefined,
): string {
  let total = 0;
  let anyTimed = false;
  for (const item of items) {
    const ms = computeItemDurationMs(item, nowMs);
    if (ms == null) continue;
    anyTimed = true;
    total += ms;
  }
  if (!anyTimed) return "";
  return formatMs(total);
}

/**
 * Build the tool-detail drawer payload for a single tool call. Shared by the
 * activity-run card's tool-step pill and the inline single-tool chip so the
 * drawer payload construction lives in one place. Reuses the same
 * `deriveStepLabel` / status / duration derivations the card row uses, so the
 * drawer opens with identical title/activity/status/duration regardless of
 * which affordance the user clicks.
 */
export function toolDetailPayloadFromToolCall(
  tc: ChatMessageToolCall,
): ToolDetailPayload {
  const { title, activity } = deriveStepLabel(tc);
  return {
    toolCallId: tc.id,
    toolName: tc.name,
    title,
    activity,
    input: tc.input ?? {},
    result: tc.result,
    streamedOutput: tc.streamedOutput,
    status: deriveToolStepStatus(tc),
    riskLevel: tc.riskLevel,
    riskReason: tc.riskReason,
    durationLabel: computeToolDurationLabel(tc),
  };
}

function buildToolStep(tc: ChatMessageToolCall): ToolCallCardStep {
  const { title, info, activity, iconName } = deriveStepLabel(tc);
  return {
    kind: "tool",
    durationLabel: computeToolDurationLabel(tc),
    startedAt: tc.startedAt ?? undefined,
    title,
    info,
    activity,
    riskLevel: tc.riskLevel,
    iconName,
    toolCallId: tc.id,
    status: deriveToolStepStatus(tc),
  };
}

// ---------------------------------------------------------------------------
// Header carousel — currentStepTitle / currentStepInfo
// ---------------------------------------------------------------------------

/**
 * Title shown in the collapsed header for the most recent tool call. Walks
 * the calls in reverse so the latest one wins, mirroring the legacy
 * web-search hook's selector logic for the web-tool branch and adding a
 * non-web `deriveStepLabel().title` branch alongside it.
 *
 * The collapsed header shows the tool's title verbatim (e.g. "Working" for
 * bash) paired with its command/activity info, so a collapsed/streaming card
 * carousels the live step ("Working | git status") rather than only the
 * stable "Working for Ns" summary. `deriveStepLabel` and `phaseFromStep`
 * stay untouched, so the EXPANDED list still groups bash steps under a
 * distinct "Working" section.
 */
function deriveCurrentStepTitle(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): string {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (isWebTool(tc)) {
      const metadata = resolveMetadata(tc, liveWebActivity);
      const terminal = isTerminalStatus(tc);
      if (
        metadata?.webSearch &&
        isFailedEmptyWebSearch(metadata.webSearch, tc)
      ) {
        return "Web search failed";
      }
      if (tc.name === "web_search") {
        return webSearchStepTitle(terminal);
      }
      if (tc.name === "web_fetch") {
        return "Thinking";
      }
    } else {
      return deriveStepLabel(tc).title;
    }
  }
  return "";
}

/**
 * Per-step subtext for the carousel header. Web branch mirrors the legacy
 * web-search hook's fallback ladder; non-web branch uses
 * `deriveStepLabel().info`.
 */
function deriveCurrentStepInfo(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): string {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (!isWebTool(tc)) {
      const { info, activity } = deriveStepLabel(tc);
      return activity || info;
    }
    const metadata = resolveMetadata(tc, liveWebActivity);
    const terminal = isTerminalStatus(tc);

    if (metadata?.webSearch) {
      const ws = metadata.webSearch;
      if (isFailedEmptyWebSearch(ws, tc)) {
        return ws.errorMessage ?? WEB_SEARCH_BACKEND_FAILURE_MESSAGE;
      }
      if (ws.results.length > 0) {
        return ws.results[ws.results.length - 1]!.title;
      }
      if (!terminal && ws.query) {
        return `Searching ${ws.query}`;
      }
    }

    if (metadata?.webFetch) {
      const wf = metadata.webFetch;
      if (terminal) {
        return wf.title ?? wf.domain;
      }
      return `Reading ${wf.domain}`;
    }

    if (tc.name === "web_search") {
      if (!terminal) {
        const query =
          typeof tc.input?.query === "string" ? tc.input.query.trim() : "";
        return query ? `Searching ${query}` : "";
      }
      if (typeof tc.result === "string") {
        const parsed = parseWebSearchResultText(tc.result);
        if (parsed.length > 0) {
          const title = parsed[parsed.length - 1]!.title;
          if (title) return title;
        }
      }
    }

    if (tc.name === "web_fetch") {
      const url = typeof tc.input?.url === "string" ? tc.input.url : "";
      const host = url ? extractDomain(url) : "";
      if (host) return terminal ? host : `Reading ${host}`;
    }
  }
  return "";
}

/**
 * Results to feed the collapsed-header rotating carousel. Returns the
 * results from the *most recently completed* `web_search` tool call, or
 * an empty array when none has landed yet (or no web_search ran at all).
 */
function deriveCarouselItems(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): WebSearchResultItem[] {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.name !== "web_search") continue;
    const metadata = resolveMetadata(tc, liveWebActivity);
    const results = metadata?.webSearch?.results;
    if (results && results.length > 0) return results;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Card-level state
// ---------------------------------------------------------------------------

/**
 * Combine per-call/per-step states into a single card-level state using the
 * canonical precedence (highest first): `denied` > `loading` > `error` >
 * `complete`. Shared so the per-turn activity aggregate (`turn-activity.ts`)
 * and `deriveCardState` below cannot drift.
 */
export function combineCardStates(
  states: Array<"loading" | "complete" | "error" | "denied">,
): "loading" | "complete" | "error" | "denied" {
  if (states.includes("denied")) return "denied";
  if (states.includes("loading")) return "loading";
  if (states.includes("error")) return "error";
  return "complete";
}

/**
 * Card-level state derivation. Maps each tool call to its narrowed state and
 * combines them via `combineCardStates`. Precedence (highest first):
 *   1. `denied` — any tool call whose confirmation was denied or timed-out.
 *   2. `loading` — any tool call still running.
 *   3. `error` — any tool ended in `status === "error"` (no still-running).
 *   4. `complete` — every tool call reached a terminal status without error.
 */
function deriveCardState(
  toolCalls: ChatMessageToolCall[],
): "loading" | "complete" | "error" | "denied" {
  return combineCardStates(
    toolCalls.map((tc) => {
      if (
        tc.confirmationDecision === "denied" ||
        tc.confirmationDecision === "timed_out"
      ) {
        return "denied";
      }
      if (isToolCallRunning(tc)) return "loading";
      if (tc.isError) return "error";
      return "complete";
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ordered input item for {@link computeToolCallCardDataFromItems}. A `thinking`
 * item carries an already-resolved reasoning string; a `toolCall` item carries
 * a single tool call. Walking these in order lets the card interleave thinking
 * between tool steps (e.g. `thinking → tool → thinking`) rather than only
 * prepending a single leading-thinking step ahead of all tools.
 */
export type ToolCallCardItem =
  | {
      kind: "thinking";
      text: string;
      /** Epoch-ms start of the reasoning run (earliest stamped thinking block). */
      startedAt?: number;
      /** Epoch-ms end of the reasoning run (latest stamped thinking block). */
      completedAt?: number;
    }
  | { kind: "toolCall"; toolCall: ChatMessageToolCall };

/**
 * Build the per-tool {@link ToolCallCardStep} for a single tool call, mirroring
 * the web/non-web branch logic of {@link computeToolCallCardData}. Returns
 * `null` for a `subagent_spawn` call (rendered inline elsewhere). Shared by
 * both the legacy `(toolCalls, …)` projection and the ordered-items projection
 * so the per-tool behaviour cannot drift.
 */
function buildStepForToolCall(
  tc: ChatMessageToolCall,
  liveWebActivity: Record<string, ToolActivityMetadata>,
): ToolCallCardStep | null {
  if (isSubagentSpawnCall(tc)) return null;
  if (!isWebTool(tc)) {
    return buildToolStep(tc);
  }
  const metadata = resolveMetadata(tc, liveWebActivity);
  const terminal = isTerminalStatus(tc);
  if (metadata?.webSearch) {
    const ws = metadata.webSearch;
    if (isFailedEmptyWebSearch(ws, tc)) {
      return buildWebSearchErrorStep(ws);
    }
    return buildWebSearchStep(ws, terminal);
  }
  if (metadata?.webFetch) {
    return buildWebFetchStep(metadata.webFetch);
  }
  if (!terminal) {
    return tc.name === "web_search"
      ? buildWebSearchPlaceholderStep()
      : buildWebFetchPlaceholderStep();
  }
  if (tc.name === "web_search" && typeof tc.result === "string") {
    return (
      buildWebSearchStepFromResultText(tc.result) ?? buildEmptyWebSearchStep()
    );
  }
  return buildEmptyWebSearchStep();
}

/**
 * Pure projection of ordered (thinking | toolCall) items → card data. Walks the
 * items IN ORDER so thinking steps interleave with tool steps. The card-level
 * header / state / carousel derive from the renderable (non-spawn) tool calls,
 * exactly as the legacy `(toolCalls, …)` projection does.
 */
export function computeToolCallCardDataFromItems(
  items: ToolCallCardItem[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
  nowMs?: number,
): ToolCallCardData {
  const toolCalls = items
    .filter(
      (i): i is { kind: "toolCall"; toolCall: ChatMessageToolCall } =>
        i.kind === "toolCall",
    )
    .map((i) => i.toolCall);
  // `subagent_spawn` calls are rendered inline by `InlineProcessCard` (via the
  // subagent descriptor) at the transcript level — surfacing them as steps
  // inside the unified card would render the spawn twice.
  const renderableToolCalls = toolCalls.filter(
    (tc) => !isSubagentSpawnCall(tc),
  );

  const steps: ToolCallCardStep[] = [];
  // Tracks the text of the most recently pushed step that originated from a
  // GENUINE thinking *item* (a `{ kind: "thinking" }` reasoning segment) and
  // is still the last step in the list. Web-tool synthesis can also emit
  // `kind: "thinking"` steps (`web_fetch` "Reading …"); those must keep
  // flowing through the tool/web header derivation, so we don't promote them
  // to a "Thinking" header.
  let trailingThinkingText: string | null = null;
  // Ordinal of each genuine reasoning segment, in render order. Stamped onto its
  // step so the drawer can re-derive that exact segment's live text. Mirrors the
  // segment order `useLiveThinkingText` walks (truthy thinking items only).
  let thinkingItemIndex = 0;
  for (const item of items) {
    if (item.kind === "thinking") {
      if (item.text) {
        steps.push({
          kind: "thinking",
          durationLabel: computeDurationLabel(item.startedAt, item.completedAt),
          text: item.text,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          thinkingItemIndex: thinkingItemIndex++,
        });
        trailingThinkingText = item.text;
      }
      continue;
    }
    const step = buildStepForToolCall(item.toolCall, liveWebActivity);
    if (step) {
      steps.push(step);
      trailingThinkingText = null;
    }
  }

  const state = deriveCardState(renderableToolCalls);

  // The collapsed header reflects the LATEST built step. When the run ends in
  // a genuine thinking segment (e.g. `tool → thinking`), the header carousels
  // to that thinking text under a "Thinking" title — we have no per-segment
  // daemon label. Otherwise it keeps the existing tool/web derivation so
  // web-search header nuances (tense, error copy, query subtext) and the
  // synthetic web placeholders are preserved.
  let currentStepTitle: string;
  let currentStepInfo: string;
  let currentStepKind: "thinking" | "tool";
  if (trailingThinkingText !== null) {
    currentStepTitle = "Thinking";
    currentStepInfo = trailingThinkingText;
    currentStepKind = "thinking";
  } else {
    currentStepTitle = deriveCurrentStepTitle(
      renderableToolCalls,
      liveWebActivity,
    );
    currentStepInfo = deriveCurrentStepInfo(
      renderableToolCalls,
      liveWebActivity,
    );
    currentStepKind = "tool";
  }

  const carouselItems = deriveCarouselItems(
    renderableToolCalls,
    liveWebActivity,
  );
  const stepCount = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const totalDurationLabel = computeTotalDurationLabel(items, nowMs);

  return {
    currentStepTitle,
    currentStepInfo,
    currentStepKind,
    stepCount,
    totalDurationLabel,
    steps,
    state,
    carouselItems,
  };
}

/**
 * Pure projection of (toolCalls, liveWebActivity) → card data. Split out
 * from the hook so tests can drive it without React context plumbing.
 *
 * Always returns a `ToolCallCardData` (never null) so non-web groups still
 * render the unified card. Callers that need legacy "no web tools → bail
 * to legacy card" behaviour (the PR-6 cutover keeps the legacy card alive
 * for mixed/pending-confirmation groups) should layer that decision on top.
 *
 * Delegates to {@link computeToolCallCardDataFromItems} after wrapping the
 * tool calls into ordered items — producing output identical to the
 * historical inline loop.
 */
export function computeToolCallCardData(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
  nowMs?: number,
): ToolCallCardData {
  const items: ToolCallCardItem[] = toolCalls.map((tc) => ({
    kind: "toolCall",
    toolCall: tc,
  }));
  return computeToolCallCardDataFromItems(items, liveWebActivity, nowMs);
}
