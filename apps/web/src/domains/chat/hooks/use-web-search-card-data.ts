/**
 * Builds the props for `WebSearchProgressCard` from the active turn's
 * tool calls + `liveWebActivity` metadata.
 *
 * Returns `null` when no tool call in the supplied list is a web tool
 * (`web_search` / `web_fetch`) — callers should fall back to the legacy
 * `ToolCallProgressCard` rendering. When at least one web tool is present,
 * the hook walks the tool calls in order and emits a `StepDescriptor` for
 * each. Metadata is sourced from either the live turn state
 * (`liveWebActivity[tc.id]`) or, once that is cleared on idle transitions,
 * from the tool call's persisted `activityMetadata` field (stamped by
 * `applyToolResult`). In-flight calls with no metadata yet get a
 * `"Searching..."` placeholder so the card renders immediately on
 * `tool_use_start` rather than waiting for `tool_result`.
 *
 * Returns a `state: "loading" | "complete"` flag derived from the tool-call
 * statuses so the card chrome (indicator icon, header label, carousel) can
 * swap between the live and completed presentations.
 *
 * Historical reopens — a server-hydrated message whose tool calls have no
 * persisted metadata — still emit a minimal `web_search` step so the new
 * card chrome stays consistent. The legacy card path is reserved for
 * non-web tools and mixed/confirmation groups.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types.js";
import {
  extractDomain,
  parseWebSearchResultText,
} from "@/domains/chat/utils/web-search-result-text.js";
import type { StepDescriptor } from "@/domains/chat/components/web-search/web-search-progress-card.js";
import { useTurnStore } from "@/domains/messaging/turn-store.js";

/** Max favicon chips to render inside a single `web_search` step row. */
const MAX_VISIBLE_RESULTS = 5;

/** Tool names whose presence triggers the web-search card path. */
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

export interface WebSearchCardData {
  /**
   * Title text rendered in the collapsed header. Reflects the most recent
   * step's per-row title (e.g. "Searching the web" → "Searched the web") so
   * the header carousels through each step's tense as the turn progresses.
   * Falls back to the overall card-level label when no steps have rendered.
   */
  currentStepTitle: string;
  /**
   * Per-step gray subtext rendered after the title. Animates alongside
   * `currentStepTitle` via the card's throttled carousel.
   *
   * Semantics per step kind (see `deriveCurrentStepInfo` for the full table):
   *   - thinking (in-flight, real reasoning) → the model's reasoning text
   *   - web_fetch (in-flight) → "Reading <domain>"
   *   - web_fetch (completed) → page title or fallback domain
   *   - web_search (in-flight, no results yet) → "Searching <query>"
   *   - web_search (results present) → the last result's title
   *   - web_search_error → the provider's error message
   *   - historical reopen with no data → empty string
   */
  currentStepInfo: string;
  stepCount: string;
  steps: StepDescriptor[];
  /**
   * Visual state of the card:
   * - `"loading"` while any web tool call is still running (or pending
   *   confirmation rejected upstream)
   * - `"complete"` once every web tool call has reached a terminal status
   *   (`completed` / `error`)
   * Drives the header indicator (animated dots vs. static check) and the
   * per-step row tense in the expanded body.
   */
  state: "loading" | "complete";
  /**
   * Results from the most recently completed `web_search` in the turn,
   * suitable for feeding the collapsed-header `WebsiteCarousel`.
   *
   * The daemon emits `web_search` results atomically on `tool_result` — there
   * is no mid-stream progress event. So this stays empty until at least one
   * search returns, and re-feeds each time a subsequent search completes
   * (the carousel always reflects the most recent search batch).
   *
   * Sourced from `liveWebActivity[tc.id]` first, falling back to the
   * persisted `tc.activityMetadata` for historical reopens. Skips
   * error-state results (an `errorMessage` with empty `results` would yield
   * nothing to show anyway).
   */
  carouselItems: WebSearchResultItem[];
}

/**
 * Format a duration in ms for the row-meta cluster (e.g. `<1s`, `2s`).
 *
 * Exported for direct testing — the rest of this module's behaviour is
 * exercised end-to-end via the React hook.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  return `${Math.round(ms / 1000)}s`;
}

/**
 * True when `tc.toolName` is a web tool (`web_search` / `web_fetch`).
 *
 * Anthropic-native `web_search` is the only path that currently emits
 * `activityMetadata`; OpenAI's `web_search_call` does not (it has a
 * different tool name and no metadata) so this gate also correctly skips
 * it, falling back to the legacy card.
 */
function isWebTool(tc: ChatMessageToolCall): boolean {
  return WEB_TOOL_NAMES.has(tc.toolName);
}

/**
 * Decide the StepRow label for a `web_search` row. Past-tense once the
 * underlying tool call is terminal so a completed turn doesn't read as if
 * the search is still in flight ("Searching the web · 0 links" was the
 * pre-fix complaint).
 */
function webSearchStepTitle(terminal: boolean): string {
  return terminal ? "Searched the web" : "Searching the web";
}

/**
 * Clamp a result list to the visible cap and report the overflow count for
 * the trailing "+N more" pill. Shared between the structured-metadata path
 * and the result-text fallback so both rows follow the same truncation rule.
 */
function clampResults(results: WebSearchResultItem[]): {
  visible: WebSearchResultItem[];
  overflow: number;
} {
  return {
    visible: results.slice(0, MAX_VISIBLE_RESULTS),
    overflow: Math.max(0, results.length - MAX_VISIBLE_RESULTS),
  };
}

function buildWebSearchStep(
  metadata: NonNullable<ToolActivityMetadata["webSearch"]>,
  terminal: boolean,
): StepDescriptor {
  const { visible, overflow } = clampResults(metadata.results);
  return {
    kind: "web_search",
    title: webSearchStepTitle(terminal),
    durationLabel: formatMs(metadata.durationMs),
    linkCount: metadata.resultCount,
    results: visible,
    overflow,
  };
}

function buildWebFetchStep(
  metadata: NonNullable<ToolActivityMetadata["webFetch"]>,
): StepDescriptor {
  const label = metadata.title ?? metadata.domain;
  return {
    kind: "thinking",
    durationLabel: formatMs(metadata.durationMs),
    text: `Reading ${label}`,
  };
}

function buildPlaceholderStep(): StepDescriptor {
  return { kind: "thinking", durationLabel: "", text: "Searching..." };
}

/**
 * Reconstruct a `web_search` step from the daemon's `result: string` text
 * dump. The Anthropic-native daemon path doesn't persist `activityMetadata`
 * across reloads (v1 scope) but it does persist `tc.result` — the same
 * text the model sees. Parsing that recovers titles + URLs so the step
 * row can render real chips instead of "0 links". We don't recover
 * snippet, duration, provider, or favicon — those stay omitted and the
 * card degrades gracefully (FaviconChip falls back to a domain monogram).
 *
 * Returns `null` when parsing yields no URLs — caller falls through to the
 * empty fallback.
 */
function buildWebSearchStepFromResultText(
  text: string,
): (StepDescriptor & { kind: "web_search" }) | null {
  const parsed = parseWebSearchResultText(text);
  if (parsed.length === 0) return null;
  const { visible, overflow } = clampResults(parsed);
  return {
    kind: "web_search",
    // Always past-tense — this fallback only runs when the call is terminal.
    title: webSearchStepTitle(true),
    durationLabel: "",
    linkCount: parsed.length,
    results: visible,
    overflow,
  };
}

function buildWebSearchErrorStep(
  metadata: NonNullable<ToolActivityMetadata["webSearch"]>,
): StepDescriptor {
  return {
    kind: "web_search_error",
    title: "Web search failed",
    durationLabel: formatMs(metadata.durationMs),
    errorMessage: metadata.errorMessage ?? "Search failed.",
  };
}

/**
 * Historical-reopen fallback row. Used when the tool call is terminal but
 * neither `liveWebActivity` nor the persisted `tc.activityMetadata` carry
 * the structured payload AND the result text didn't parse into anything
 * useful (no URLs). Renders the new card chrome with an empty results row
 * rather than falling back to the legacy card so the visual language stays
 * consistent.
 */
function buildEmptyWebSearchStep(): StepDescriptor {
  return {
    kind: "web_search",
    title: webSearchStepTitle(true),
    durationLabel: "",
    linkCount: 0,
    results: [],
  };
}

/** Resolve the structured metadata for a tool call from either source. */
function resolveMetadata(
  tc: ChatMessageToolCall,
  liveWebActivity: Record<string, ToolActivityMetadata>,
): ToolActivityMetadata | undefined {
  return liveWebActivity[tc.id] ?? tc.activityMetadata;
}

/** Tool-call statuses that count as terminal (no further work expected). */
function isTerminalStatus(tc: ChatMessageToolCall): boolean {
  return tc.status === "completed" || tc.status === "error";
}

/**
 * Per-step title for the carousel header. Reflects the *most recent* web
 * tool call's own row title so the header reads in-context as the turn
 * progresses (e.g. "Searching the web" → "Searched the web" → "Searched
 * the web" again on a follow-up query). Falls back to the empty string if
 * no web tool call is present (caller hides the row).
 */
function deriveCurrentStepTitle(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): string {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (!isWebTool(tc)) continue;
    const metadata = resolveMetadata(tc, liveWebActivity);
    const terminal = isTerminalStatus(tc);
    // web_search_error precedence mirrors the step builder: error row when
    // the search itself failed and there are no results to surface.
    if (
      metadata?.webSearch &&
      metadata.webSearch.errorMessage &&
      metadata.webSearch.results.length === 0
    ) {
      return "Web search failed";
    }
    if (tc.toolName === "web_search") {
      return webSearchStepTitle(terminal);
    }
    if (tc.toolName === "web_fetch") {
      // web_fetch steps render under a generic "Thinking" row in the
      // expanded body (the selector currently maps fetches to a `thinking`
      // descriptor). Mirror that label in the header so the carousel
      // transition stays semantically aligned with what the user sees on
      // expand.
      return "Thinking";
    }
  }
  return "";
}

/**
 * Results to feed the collapsed-header `WebsiteCarousel` (favicon + title
 * chips rotating). Returns the result list from the most recently completed
 * `web_search` tool call, or an empty array when nothing has landed yet.
 *
 * Why the *latest* search only (not a flatMap across all searches):
 * - Keeps the carousel "current" — what the model just looked at rotates,
 *   re-feeding as each subsequent search completes.
 * - Bounds the rotation cycle to a single search's `resultCount` (~5 items
 *   @2.5s = ~12.5s full loop), so the carousel doesn't drag through a
 *   20-item backlog by the end of a long turn.
 *
 * Skips searches with no results — both empty-results-with-error rows and
 * pristine in-flight calls — so the carousel only ever feeds on real data.
 */
function deriveCarouselItems(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): WebSearchResultItem[] {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (tc.toolName !== "web_search") continue;
    const metadata = resolveMetadata(tc, liveWebActivity);
    const results = metadata?.webSearch?.results;
    if (results && results.length > 0) return results;
  }
  return [];
}

/**
 * Per-step gray subtext shown in the collapsed header. The card carousels
 * through this value alongside `currentStepTitle` so each transition reads
 * as a discrete step. Driven by the *most recent* web tool call.
 *
 * Strategy (walks tool calls in reverse so the latest wins):
 *   1. web_search with `errorMessage` and empty results → the error message.
 *   2. web_search with any results (in-flight or terminal) → the *last*
 *      result's `title`. The trailing result is the most recently surfaced
 *      to the user, so it reads as "what we just looked at".
 *   3. web_search in-flight with no results yet → `Searching <query>` from
 *      the tool-call input, falling back to empty when no query is present.
 *   4. web_fetch in-flight → `Reading <domain>` derived from the metadata
 *      (or, when metadata is absent, the tool-call input URL's host).
 *   5. web_fetch terminal → `metadata.title ?? metadata.domain`.
 *   6. Reload fallback: a terminal web_search with no metadata but a
 *      parseable `tc.result` string dump → the last recovered title.
 *   7. Otherwise (historical reopen with nothing to recover) → empty
 *      string.
 */
function deriveCurrentStepInfo(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): string {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]!;
    if (!isWebTool(tc)) continue;
    const metadata = resolveMetadata(tc, liveWebActivity);
    const terminal = isTerminalStatus(tc);

    if (metadata?.webSearch) {
      const ws = metadata.webSearch;
      if (ws.errorMessage && ws.results.length === 0) {
        return ws.errorMessage;
      }
      if (ws.results.length > 0) {
        return ws.results[ws.results.length - 1]!.title;
      }
      // Live metadata exists but no results yet (mid-stream). Prefer the
      // query from metadata over the input field — it's the canonical
      // copy the provider acted on.
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

    // No metadata path
    if (tc.toolName === "web_search") {
      if (!terminal) {
        const query =
          typeof tc.input?.query === "string" ? tc.input.query.trim() : "";
        return query ? `Searching ${query}` : "";
      }
      // Reload fallback — parse the daemon's result-string dump and use
      // the last recovered title so the header still reads as a page
      // title rather than empty.
      if (typeof tc.result === "string") {
        const parsed = parseWebSearchResultText(tc.result);
        if (parsed.length > 0) {
          const title = parsed[parsed.length - 1]!.title;
          // Some providers (Perplexity citations) have URL-only entries —
          // skip those rather than fall back to an empty string.
          if (title) return title;
        }
      }
    }

    if (tc.toolName === "web_fetch") {
      // No metadata — best-effort `Reading <host>` from `tc.input.url` so
      // the header is useful while the fetch is in flight.
      const url = typeof tc.input?.url === "string" ? tc.input.url : "";
      const host = url ? extractDomain(url) : "";
      if (host) return terminal ? host : `Reading ${host}`;
    }
  }
  return "";
}

export function useWebSearchCardData(
  toolCalls: ChatMessageToolCall[],
): WebSearchCardData | null {
  // Subscribe directly to the turn store — no React context required.
  // The store returns the canonical empty-object reference between
  // terminal transitions so identity stays stable when nothing is live.
  const liveWebActivity = useTurnStore.use.liveWebActivity();
  return computeWebSearchCardData(toolCalls, liveWebActivity);
}

/**
 * Pure projection of (toolCalls, liveWebActivity) → card props. Split out
 * from the hook so tests can drive it without React context plumbing.
 */
export function computeWebSearchCardData(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): WebSearchCardData | null {
  const hasAnyWebTool = toolCalls.some(isWebTool);
  if (!hasAnyWebTool) return null;

  // Mixed-group guard: `TranscriptMessageBody` groups consecutive tool calls
  // into a single `ToolCallProgressCard`. When such a group mixes web and
  // non-web tool calls (e.g. `web_search` + `bash`), short-circuiting to the
  // web-search card silently drops the non-web entries because the iteration
  // below skips them. Defer to the legacy card whenever the group isn't
  // purely web tools so every call still renders.
  if (!toolCalls.every(isWebTool)) return null;

  // Pending-confirmation guard: when strict-mode permission prompts a web
  // tool, the legacy `ToolCallProgressCard` surfaces approve/deny buttons via
  // `pendingConfirmationToolCallId` + `onConfirmationSubmit`. The new card
  // path doesn't thread that UI, so bail to the legacy card whenever any tool
  // call is awaiting confirmation — otherwise the user is stuck on
  // "Searching..." indefinitely.
  if (toolCalls.some((tc) => tc.pendingConfirmation != null)) return null;

  const steps: StepDescriptor[] = [];
  let anyInFlight = false;

  for (const tc of toolCalls) {
    if (!isWebTool(tc)) continue;
    const metadata = resolveMetadata(tc, liveWebActivity);
    const terminal = isTerminalStatus(tc);
    if (!terminal) anyInFlight = true;
    if (metadata?.webSearch) {
      const ws = metadata.webSearch;
      // Error-state precedence: when the search itself failed the provider
      // emits `errorMessage` and `results` is empty — surface a distinct
      // error row instead of an empty results row that reads as success.
      if (ws.errorMessage && ws.results.length === 0) {
        steps.push(buildWebSearchErrorStep(ws));
      } else {
        steps.push(buildWebSearchStep(ws, terminal));
      }
    } else if (metadata?.webFetch) {
      steps.push(buildWebFetchStep(metadata.webFetch));
    } else if (!terminal) {
      steps.push(buildPlaceholderStep());
    } else if (tc.toolName === "web_search" && typeof tc.result === "string") {
      // Terminal `web_search` with no structured metadata anywhere — most
      // likely a page reload (the daemon doesn't persist `activityMetadata`
      // per v1 scope, only `result: string` survives in the snapshot).
      // Best-effort parse the text dump so the row still shows favicon
      // chips rather than "0 links". webFetch's `result` is the raw page
      // body — not worth parsing — so we let it fall through to the empty
      // fallback below.
      const parsed = buildWebSearchStepFromResultText(tc.result);
      if (parsed) {
        steps.push(parsed);
      } else {
        steps.push(buildEmptyWebSearchStep());
      }
    } else {
      // Terminal status, no metadata, no parseable result text — emit an
      // empty `web_search` row so the new card chrome still renders.
      steps.push(buildEmptyWebSearchStep());
    }
  }

  const state: "loading" | "complete" = anyInFlight ? "loading" : "complete";
  const currentStepTitle = deriveCurrentStepTitle(toolCalls, liveWebActivity);
  const currentStepInfo = deriveCurrentStepInfo(toolCalls, liveWebActivity);
  const carouselItems = deriveCarouselItems(toolCalls, liveWebActivity);
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
