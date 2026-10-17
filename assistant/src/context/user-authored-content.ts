/**
 * Which blocks of a user-role message the user actually sent.
 *
 * A user-role message is not always a prompt. The agent loop answers every
 * tool call with one, and the runtime injects `<system_notice>` guidance
 * (retry nudges, post-tool-use coaching) either alongside those tool results
 * or as a message of its own. A message carries user-authored content only
 * when it has some other block: text the user typed, an attachment, or the
 * prompt a channel or schedule delivered on the user's behalf.
 */

import type { ContentBlock, Message } from "../providers/types.js";

/** A tool result: a client `tool_result` or a server `web_search_tool_result`. */
export function isToolResultBlock(block: ContentBlock): boolean {
  return (
    block.type === "tool_result" || block.type === "web_search_tool_result"
  );
}

/** A `<system_notice>` text block the runtime injected, not text the user wrote. */
export function isSystemNoticeBlock(block: ContentBlock): boolean {
  return (
    block.type === "text" &&
    block.text.startsWith("<system_notice>") &&
    block.text.endsWith("</system_notice>")
  );
}

/** Whether a user-role message has a block besides tool results and system notices. */
export function hasUserAuthoredContent(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.some(
      (block) => !isToolResultBlock(block) && !isSystemNoticeBlock(block),
    )
  );
}
