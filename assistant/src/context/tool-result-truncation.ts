import { truncateToolResultText } from "../plugins/defaults/tool-result-truncate/terminal.js";
import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";

/**
 * Maximum share of the context window that a single tool result may occupy.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Absolute cap on tool-result characters (~100K tokens).
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

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
 * Aggressively truncate all tool-result text across an entire message history.
 *
 * Walks every message and truncates tool_result `.content` strings that
 * exceed `maxChars`. Used during overflow recovery where we need to shrink
 * the overall payload, not just individual oversized results.
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
