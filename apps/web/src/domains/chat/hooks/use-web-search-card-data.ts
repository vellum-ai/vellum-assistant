/**
 * Thin wrapper around {@link useToolCallCardData} / {@link computeToolCallCardData}
 * that preserves the legacy `WebSearchCardData` shape consumed by
 * `ToolCallProgressCard` (PR 6 retires this consumer).
 *
 * Behaviour relative to the unified hook:
 *   - Returns `null` when no tool call is a web tool (`web_search` /
 *     `web_fetch`) so the legacy card path can still render non-web groups.
 *   - Bails to `null` for mixed groups (any non-web tool present) so the
 *     legacy card renders every call rather than silently dropping the
 *     non-web entries.
 *   - Bails to `null` whenever any tool call is awaiting confirmation —
 *     strict-mode permission prompts surface approve/deny UI in the legacy
 *     card and the web-search card path doesn't thread that plumbing.
 *   - Narrows the unified card's wider `state` enum back to
 *     `"loading" | "complete"` since the legacy card doesn't render
 *     `"error"` / `"denied"` chrome.
 *
 * The narrow set of historical behaviours above is locked in by
 * `use-web-search-card-data.test.ts`, which now exercises this wrapper as
 * a regression suite against the unified pipeline.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types.js";
import type { StepDescriptor } from "@/domains/chat/components/web-search/web-search-progress-card.js";
import {
  computeToolCallCardData,
  hasWebTool,
  WEB_TOOL_NAMES,
  formatMs,
  useToolCallCardData,
  type ToolCallCardData,
} from "@/domains/chat/hooks/use-tool-call-card-data.js";

// Re-exports preserved for any straggler imports of the old module name.
export { formatMs, WEB_TOOL_NAMES };

/**
 * Legacy card-data shape consumed by `WebSearchProgressCard`. Mirrors
 * `ToolCallCardData` field-for-field but:
 *   - `steps` is the narrower `StepDescriptor[]` (no `tool` variant).
 *   - `state` is narrower (`"loading" | "complete"` only).
 *   - `leadingIcon` is omitted (web-only path never sets it).
 */
export interface WebSearchCardData {
  currentStepTitle: string;
  currentStepInfo: string;
  stepCount: string;
  steps: StepDescriptor[];
  state: "loading" | "complete";
  carouselItems: WebSearchResultItem[];
}

/**
 * Guards that decide whether the legacy card path applies. Mirrors the
 * historical bail-outs from the pre-unification implementation.
 */
function shouldUseLegacyWebSearchCard(
  toolCalls: ChatMessageToolCall[],
): boolean {
  if (!hasWebTool(toolCalls)) return false;
  // Mixed-group guard — `TranscriptMessageBody` groups consecutive tool
  // calls into a single card; a mix of web + non-web must defer to the
  // legacy card so every call still renders.
  if (!toolCalls.every((tc) => WEB_TOOL_NAMES.has(tc.toolName))) return false;
  // Pending-confirmation guard — the legacy card threads approve/deny UI
  // that the web-search card doesn't render.
  if (toolCalls.some((tc) => tc.pendingConfirmation != null)) return false;
  return true;
}

/**
 * Narrow the unified card output to the legacy shape. Steps are cast to
 * `StepDescriptor[]` — every step emitted for purely-web groups is already
 * one of the three legacy descriptor kinds by construction (the `tool`
 * variant only appears for non-web tools, filtered out by the guards).
 */
function narrowToWebSearchCardData(
  unified: ToolCallCardData,
): WebSearchCardData {
  return {
    currentStepTitle: unified.currentStepTitle,
    currentStepInfo: unified.currentStepInfo,
    stepCount: unified.stepCount,
    steps: unified.steps as StepDescriptor[],
    // For purely-web groups, the wider state collapses to the legacy
    // two-value enum (no denied confirmations, errors collapse to complete
    // per the legacy contract).
    state: unified.state === "loading" ? "loading" : "complete",
    carouselItems: unified.carouselItems,
  };
}

/**
 * Pure projection compatible with the historical signature. Returns
 * `null` for the same set of cases the original implementation did so the
 * upstream call site keeps falling back to the legacy card unchanged.
 */
export function computeWebSearchCardData(
  toolCalls: ChatMessageToolCall[],
  liveWebActivity: Record<string, ToolActivityMetadata>,
): WebSearchCardData | null {
  if (!shouldUseLegacyWebSearchCard(toolCalls)) return null;
  return narrowToWebSearchCardData(
    computeToolCallCardData(toolCalls, liveWebActivity, null),
  );
}

export function useWebSearchCardData(
  toolCalls: ChatMessageToolCall[],
): WebSearchCardData | null {
  // Hook is unconditionally called to keep React's rules-of-hooks happy;
  // the cheap subscription is wasted in the no-web-tool fall-through but
  // that path renders the legacy card anyway and re-walks the same data.
  const unified = useToolCallCardData(toolCalls, null);
  if (!shouldUseLegacyWebSearchCard(toolCalls)) return null;
  return narrowToWebSearchCardData(unified);
}
