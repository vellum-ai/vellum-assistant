import { truncateToolResultText } from "../plugins/defaults/tool-result-truncate/terminal.js";
import type {
  ContentBlock,
  Message,
  ToolResultContent,
} from "../providers/types.js";

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
