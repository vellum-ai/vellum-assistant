/**
 * Terminal handler for the default `toolResultTruncate` pipeline, plus the
 * truncation primitive it wraps.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call site in `agent/loop.ts`.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 17).
 */

import { safeStringSlice } from "../../../util/unicode.js";
import type {
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
} from "../../types.js";

/**
 * Minimum number of characters to preserve when truncating.
 */
export const MIN_KEEP_CHARS = 2_000;

/**
 * Suffix appended to truncated tool results.
 */
export const TRUNCATION_SUFFIX =
  "\n\n[Content truncated — original exceeded size limit. Use offset/limit parameters or request specific sections for large content.]";

/**
 * Truncate text with newline-boundary awareness.
 *
 * If `text.length <= maxChars`, the text is returned as-is.
 * Otherwise we look for the last newline that falls within 80% of the budget
 * so we get a clean cut. At least `MIN_KEEP_CHARS` characters are always
 * preserved.
 */
export function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const effectiveMax = Math.max(maxChars, MIN_KEEP_CHARS);
  const cutPoint = effectiveMax - TRUNCATION_SUFFIX.length;

  // Look for a newline within the last 20% of the budget for a clean break.
  const threshold = Math.floor(cutPoint * 0.8);
  const lastNewline = text.lastIndexOf("\n", cutPoint);

  const sliceEnd = lastNewline >= threshold ? lastNewline : cutPoint;

  // If sliceEnd covers the full text, nothing was actually removed — return
  // the original text without appending the suffix.
  if (sliceEnd >= text.length) {
    return text;
  }

  return safeStringSlice(text, 0, sliceEnd) + TRUNCATION_SUFFIX;
}

/**
 * Terminal handler for the `toolResultTruncate` pipeline. Exported so tests
 * can verify default behavior directly without going through `runPipeline`,
 * and so `agent/loop.ts` can pass it as the `terminal` argument to
 * `runPipeline`.
 */
export function defaultToolResultTruncateTerminal(
  args: ToolResultTruncateArgs,
): ToolResultTruncateResult {
  const truncated = truncateToolResultText(args.content, args.maxChars);
  return {
    content: truncated,
    truncated: truncated !== args.content,
  };
}
