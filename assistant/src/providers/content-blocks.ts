/**
 * Shared predicates over the raw model-loop {@link ContentBlock} union.
 *
 * The agent loop and the receive-side credential guard judge "did this turn
 * produce anything" the same way, so the predicates live here rather than in
 * each consumer. Plugins keep their own copies: a plugin may not import from
 * outside its own directory.
 */

import type { ContentBlock } from "./types.js";

/** Whether `content` carries at least one non-empty `text` block. */
export function hasVisibleText(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
}

/** Whether `content` carries at least one tool call. */
export function hasToolUse(content: ReadonlyArray<ContentBlock>): boolean {
  return content.some((block) => block.type === "tool_use");
}
