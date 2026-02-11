/**
 * Pure utility functions for chat autocomplete suggestions.
 *
 * These are intentionally framework-agnostic — no React, no fetch, no DOM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestionMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result?: string; isError?: boolean }[];
}

export interface ShouldShowSuggestionParams {
  input: string;
  lastRole: "user" | "assistant" | undefined;
  isWaitingForResponse: boolean;
  isAlive: boolean;
}

// ---------------------------------------------------------------------------
// sanitizeSuggestion
// ---------------------------------------------------------------------------

/**
 * Clean and truncate a raw suggestion string.
 *
 * - Trims surrounding whitespace.
 * - Keeps only the first line (single-line suggestion).
 * - Truncates to `maxLen` characters.
 * - Returns `null` for empty / whitespace-only input.
 */
export function sanitizeSuggestion(raw: string, maxLen = 200): string | null {
  const firstLine = raw.split("\n")[0].trim();
  if (firstLine.length === 0) return null;
  return firstLine.length <= maxLen ? firstLine : firstLine.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// extractSuggestibleAssistantText
// ---------------------------------------------------------------------------

/**
 * Given the last message, extract the text portion that is suitable for
 * deriving a suggestion. Returns `null` when:
 * - The message is not from the assistant.
 * - The assistant message has no text content (e.g. tool-only).
 */
export function extractSuggestibleAssistantText(message: SuggestionMessage): string | null {
  if (message.role !== "assistant") return null;

  const text = message.content.trim();
  if (text.length === 0) return null;

  return text;
}

// ---------------------------------------------------------------------------
// buildHeuristicSuggestion
// ---------------------------------------------------------------------------

const QUESTION_RE = /\?[\s"'`)*\]]*$/;

/**
 * Build a short heuristic follow-up suggestion from the assistant's last text.
 *
 * Strategy (v1 — intentionally simple):
 * 1. If the text ends with a question → "Yes"
 * 2. Otherwise → "Tell me more"
 */
export function buildHeuristicSuggestion(lastAssistantText: string): string | null {
  const sanitized = sanitizeSuggestion(lastAssistantText);
  if (!sanitized) return null;

  // Use the full (non-sanitized) text for question detection since the
  // question mark may be beyond the truncation boundary.
  const trimmed = lastAssistantText.trim();
  if (QUESTION_RE.test(trimmed)) {
    return "Yes";
  }

  return "Tell me more";
}

// ---------------------------------------------------------------------------
// shouldShowSuggestion
// ---------------------------------------------------------------------------

/**
 * Gate whether the suggestion UI should be visible.
 *
 * All four conditions must hold:
 * 1. Composer input is empty.
 * 2. The most recent message is from the assistant.
 * 3. We are NOT currently waiting for an assistant response.
 * 4. The assistant is alive (healthy).
 */
export function shouldShowSuggestion({
  input,
  lastRole,
  isWaitingForResponse,
  isAlive,
}: ShouldShowSuggestionParams): boolean {
  if (input.length > 0) return false;
  if (lastRole !== "assistant") return false;
  if (isWaitingForResponse) return false;
  if (!isAlive) return false;
  return true;
}
