/**
 * Default `toolResultTruncate` behavior: tail-drops oversized tool-result text
 * down to a character budget, plus the truncation primitive it wraps.
 *
 * This module is side-effect free: importing it does not register any plugin.
 */

import type {
  ToolResultTruncateArgs,
  ToolResultTruncateResult,
} from "./types.js";

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Slice a string by code-unit indices without splitting a surrogate pair, so
 * the result never ends or begins mid-emoji. Indices are clamped to the
 * string bounds; a cut that would land between a high/low surrogate is nudged
 * inward to the nearest whole code point.
 */
function safeStringSlice(
  str: string,
  start = 0,
  end: number = str.length,
): string {
  let safeStart = Math.max(0, Math.min(str.length, start));
  let safeEnd = Math.max(safeStart, Math.min(str.length, end));

  if (safeEnd < str.length && safeEnd > safeStart) {
    const lastCode = str.charCodeAt(safeEnd - 1);
    if (isHighSurrogate(lastCode)) {
      safeEnd--;
    }
  }

  if (safeStart > 0 && safeStart < str.length) {
    const firstCode = str.charCodeAt(safeStart);
    if (isLowSurrogate(firstCode)) {
      safeStart++;
      if (safeStart > safeEnd) safeEnd = safeStart;
    }
  }

  return str.slice(safeStart, safeEnd);
}

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
 * Truncate a single tool-result block's content to `args.maxChars`. Exported
 * so the agent loop can call it directly and tests can verify the default
 * behavior.
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
