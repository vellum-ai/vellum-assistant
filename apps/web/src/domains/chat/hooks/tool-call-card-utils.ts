/** Pure projection and helpers for the unified tool-call progress card.
 *
 *  Separated from the React hook (`useToolCallCardData`) so they can be
 *  unit-tested without React context plumbing. The hook wires these into the
 *  Zustand turn store; these functions own the data mapping. */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types";
import {
  deriveStepLabel,
  type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import {
  extractDomain,
  parseWebSearchResultText,
} from "@/domains/chat/utils/web-search-result-text";

/** Max favicon chips to render inside a single `web_search` step row. */
const MAX_VISIBLE_RESULTS = 5;

/**
 * Friendly fallback copy for a `web_search` backend failure when the daemon
 * omits `webSearch.errorMessage`. apps/web CANNOT import from `assistant/`, so
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
 * preserve the existing `StepDescriptor` shape from
 * `WebSearchProgressCard`, so the legacy renderer keeps working unchanged.
 * The `tool` variant carries the title/info/icon tuple produced by
 * `deriveStepLabel` plus the per-call duration + status fields the unified
 * card needs to drive its row chrome. The `tool_error` variant is used by
 * `useSubagentCardData` for synthesised terminal-error events that have
 * no preceding `tool_call` (e.g. context-window blowouts surfaced via
 * the subagent timeline's `error` event type).
 */
export type ToolCallCardStep =
  | { kind: "thinking"; durationLabel: string; text: string }
  | {
      kind: "web_search";
      title: string;
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
    }
  | {
      kind: "web_search_error";
      title: string;
      durationLabel: string;
      errorMessage: string;
    }
  | {
      kind: "tool";
      durationLabel: string;
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
 * through the shell's `leadingIcon` ReactNode prop by
 * `SubagentInlineProgressCard`, so this data shape doesn't need to carry it.
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
  /** Pre-formatted step count, e.g. `"2 steps"`. */
  stepCount: string;
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

/** Format a duration in ms for the row-meta cluster (e.g. `<1s`, `2s`). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  return `${Math.round(ms / 1000)}s`;
}

/** True when `tc.name` is a web tool (`web_search` / `web_fetch`). */
function isWebTool(tc: ChatMessageToolCall): boolean {
  return WEB_TOOL_NAMES.has(tc.name);
}

/**
 * Recognise a subagent-spawn invocation in either canonical form:
 *
 * - direct `subagent_spawn` tool calls (legacy or any future path that exposes
 *   the executor as a bare tool), and
 * - `skill_execute` calls whose `input.tool === "subagent_spawn"`, which is
 *   the form the LLM actually emits today — the daemon's `skill_execute`
 *   interceptor (see `assistant/src/daemon/conversation-tool-setup.ts`)
 *   re-dispatches to the real executor under the hood, but the
 *   `tool_use_start` event the frontend receives still carries
 *   `toolName: "skill_execute"`.
 *
 * Kept local rather than imported from `transcript-message-body.tsx` so the
 * hooks module stays self-contained (no cross-domain dep on transcript code).
 */
function isSubagentSpawnLikeCall(tc: ChatMessageToolCall): boolean {
  if (tc.name === "subagent_spawn") return true;
  if (tc.name !== "skill_execute") return false;
  const input = tc.input;
  if (input == null || typeof input !== "object") return false;
  return input.tool === "subagent_spawn";
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

function buildPlaceholderStep(): ToolCallCardStep {
  return { kind: "thinking", durationLabel: "", text: "Searching..." };
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
  return tc.status === "completed" || tc.status === "error";
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
  return Boolean(ws.errorMessage) || tc.status === "error";
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
  if (tc.status === "error") return "error";
  if (tc.status === "completed") return "completed";
  return "running";
}

/**
 * Per-tool duration, mirroring the legacy generic card: start time
 * (`startedAt`) → completion time (`completedAt`) → `formatMs`. Returns an
 * empty string when timings are missing so the row chrome can hide the
 * meta cluster rather than render a misleading `<1s`.
 */
function computeToolDurationLabel(tc: ChatMessageToolCall): string {
  if (tc.startedAt == null) return "";
  if (tc.completedAt == null) {
    return "";
  }
  return formatMs(Math.max(0, tc.completedAt - tc.startedAt));
}

function buildToolStep(tc: ChatMessageToolCall): ToolCallCardStep {
  const { title, info, activity, iconName } = deriveStepLabel(tc);
  return {
    kind: "tool",
    durationLabel: computeToolDurationLabel(tc),
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
 * Card-level state derivation. Precedence (highest first):
 *   1. `denied` — any tool call whose confirmation was denied or timed-out.
 *   2. `loading` — any tool call still running.
 *   3. `error` — any tool ended in `status === "error"` (no still-running).
 *   4. `complete` — every tool call reached a terminal status without error.
 */
function deriveCardState(
  toolCalls: ChatMessageToolCall[],
): "loading" | "complete" | "error" | "denied" {
  let anyRunning = false;
  let anyError = false;
  let anyDenied = false;
  for (const tc of toolCalls) {
    if (
      tc.confirmationDecision === "denied" ||
      tc.confirmationDecision === "timed_out"
    ) {
      anyDenied = true;
    }
    if (tc.status === "running") anyRunning = true;
    if (tc.status === "error") anyError = true;
  }
  if (anyDenied) return "denied";
  if (anyRunning) return "loading";
  if (anyError) return "error";
  return "complete";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure projection of (toolCalls, liveWebActivity) → card data. Split out
 * from the hook so tests can drive it without React context plumbing.
 *
 * Always returns a `ToolCallCardData` (never null) so non-web groups still
 * render the unified card. Callers that need legacy "no web tools → bail
 * to legacy card" behaviour (the PR-6 cutover keeps the legacy card alive
 * for mixed/pending-confirmation groups) should layer that decision on top.
 */
export function computeToolCallCardData(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): ToolCallCardData {
  // `subagent_spawn` calls are rendered inline by `SubagentInlineProgressCard`
  // at the transcript level — surfacing them as steps inside the unified card
  // would render the spawn twice. The daemon exposes the spawn as a bundled
  // skill, so the LLM actually emits `skill_execute` with
  // `input.tool === "subagent_spawn"` (see `conversation-tool-setup.ts`'s
  // `skill_execute` interceptor) — matching the bare `toolName` would miss
  // every spawn and let the unified card swallow them as generic skill steps.
  const renderableToolCalls = toolCalls.filter(
    (tc) => !isSubagentSpawnLikeCall(tc),
  );

  const steps: ToolCallCardStep[] = [];

  for (const tc of renderableToolCalls) {
    if (!isWebTool(tc)) {
      steps.push(buildToolStep(tc));
      continue;
    }
    const metadata = resolveMetadata(tc, liveWebActivity);
    const terminal = isTerminalStatus(tc);
    if (metadata?.webSearch) {
      const ws = metadata.webSearch;
      if (isFailedEmptyWebSearch(ws, tc)) {
        steps.push(buildWebSearchErrorStep(ws));
      } else {
        steps.push(buildWebSearchStep(ws, terminal));
      }
    } else if (metadata?.webFetch) {
      steps.push(buildWebFetchStep(metadata.webFetch));
    } else if (!terminal) {
      steps.push(buildPlaceholderStep());
    } else if (tc.name === "web_search" && typeof tc.result === "string") {
      const parsed = buildWebSearchStepFromResultText(tc.result);
      steps.push(parsed ?? buildEmptyWebSearchStep());
    } else {
      steps.push(buildEmptyWebSearchStep());
    }
  }

  const state = deriveCardState(renderableToolCalls);
  const currentStepTitle = deriveCurrentStepTitle(
    renderableToolCalls,
    liveWebActivity,
  );
  const currentStepInfo = deriveCurrentStepInfo(
    renderableToolCalls,
    liveWebActivity,
  );
  const carouselItems = deriveCarouselItems(
    renderableToolCalls,
    liveWebActivity,
  );
  const stepCount = `${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return {
    currentStepTitle,
    currentStepInfo,
    stepCount,
    steps,
    state,
    carouselItems,
  };
}
