import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";
import { safeStringSlice } from "../util/unicode.js";

/**
 * Maximum share of the context window that a single tool result may occupy.
 */
export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Absolute cap on tool-result characters (~100K tokens).
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

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
 * Calculate the maximum allowed characters for a tool result based on the
 * context window size. Uses ~4 chars per token as a rough heuristic.
 */
export function calculateMaxToolResultChars(
  contextWindowTokens: number,
): number {
  return Math.min(
    HARD_MAX_TOOL_RESULT_CHARS,
    Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE * 4),
  );
}

/**
 * Check whether a tool-result content block exceeds the computed character
 * budget for the given context window.
 */
export function isOversizedToolResult(
  block: ToolResultContent,
  contextWindowTokens: number,
): boolean {
  if (typeof block.content !== "string") {
    return false;
  }
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return block.content.length > maxChars;
}

/**
 * If the tool-result block is oversized, return a shallow copy with its
 * `.content` truncated. Otherwise return the block unchanged.
 */
export function truncateToolResultBlock(
  block: ToolResultContent,
  contextWindowTokens: number,
): ToolResultContent {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  if (block.content.length <= maxChars) {
    return block;
  }
  return {
    ...block,
    content: truncateToolResultText(block.content, maxChars),
  };
}

/**
 * Map over an array of content blocks, truncating any oversized tool results.
 * Returns a new array and the number of blocks that were truncated.
 */
export function truncateOversizedToolResults(
  blocks: ContentBlock[],
  contextWindowTokens: number,
): { blocks: ContentBlock[]; truncatedCount: number } {
  let truncatedCount = 0;

  const mapped = blocks.map((block) => {
    if (block.type !== "tool_result") {
      return block;
    }
    const toolBlock = block as ToolResultContent;
    if (isOversizedToolResult(toolBlock, contextWindowTokens)) {
      truncatedCount++;
      return truncateToolResultBlock(toolBlock, contextWindowTokens);
    }
    return block;
  });

  return { blocks: mapped, truncatedCount };
}

/**
 * Aggressively truncate all tool-result text across an entire message history.
 *
 * Unlike `truncateOversizedToolResults` (which operates on a flat block array
 * for a single turn), this walks every message and truncates tool_result
 * `.content` strings that exceed `maxChars`. This is used during overflow
 * recovery where we need to shrink the overall payload, not just individual
 * oversized results.
 */
export function truncateToolResultsAcrossHistory(
  messages: Message[],
  maxChars: number,
): { messages: Message[]; truncatedCount: number } {
  let truncatedCount = 0;

  const mapped = messages.map((msg) => {
    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const tr = block as ToolResultContent;
      if (tr.content.length <= maxChars) return block;
      changed = true;
      truncatedCount++;
      return {
        ...tr,
        content: truncateToolResultText(tr.content, maxChars),
      } as ContentBlock;
    });
    return changed ? { ...msg, content: nextContent } : msg;
  });

  return { messages: truncatedCount > 0 ? mapped : messages, truncatedCount };
}
