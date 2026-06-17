/**
 * Convert a captured executor transcript into the message list sent to the
 * advisor sub-call.
 *
 * Two jobs:
 *  1. Strip blocks the advisor shouldn't (or can't) replay — thinking and
 *     redacted-thinking (the advisor tool drops thinking), images/files (keep
 *     the consult text-only and provider-agnostic), and opaque web-search
 *     results. Rich/nested blocks on a `tool_result` are dropped, keeping its
 *     text payload.
 *  2. Strip the *pending* tool calls from the final assistant turn. At capture
 *     time (a `post-model-call` before tools run) the last assistant message
 *     carries the `advisor` tool_use — and possibly sibling tool_use blocks —
 *     with no matching `tool_result` yet. Sending a dangling tool_use would be
 *     rejected by the provider, so those blocks are removed; earlier,
 *     already-completed tool_use/tool_result pairs are preserved intact.
 */

import type { ContentBlock, Message } from "../../../providers/types.js";

/** Drop disallowed blocks; thin out rich tool_result content. `null` = drop. */
function sanitize(block: ContentBlock): ContentBlock | null {
  switch (block.type) {
    case "thinking":
    case "redacted_thinking":
    case "image":
    case "file":
    case "web_search_tool_result":
      return null;
    case "tool_result":
      // Keep the text payload; drop nested rich blocks (e.g. images).
      return block.contentBlocks
        ? { ...block, contentBlocks: undefined }
        : block;
    default:
      return block;
  }
}

export function toAdvisorMessages(messages: ReadonlyArray<Message>): Message[] {
  const out: Message[] = [];
  const lastIndex = messages.length - 1;

  messages.forEach((message, index) => {
    let content = message.content
      .map(sanitize)
      .filter((b): b is ContentBlock => b !== null);

    // The final assistant turn's tool calls have no results yet — drop them so
    // we never send a dangling tool_use.
    if (index === lastIndex && message.role === "assistant") {
      content = content.filter(
        (b) => b.type !== "tool_use" && b.type !== "server_tool_use",
      );
    }

    if (content.length > 0) out.push({ role: message.role, content });
  });

  return out;
}
