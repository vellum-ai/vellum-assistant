/**
 * Pure utility functions for chat autocomplete suggestions.
 *
 * These are intentionally framework-agnostic — no React, no fetch, no DOM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
export function sanitizeSuggestion(raw: string, maxLen = 50): string | null {
  const firstLine = raw.split("\n")[0].trim();
  if (firstLine.length === 0) return null;
  return firstLine.length <= maxLen ? firstLine : firstLine.slice(0, maxLen);
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
