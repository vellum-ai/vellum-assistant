/**
 * Sanitize an inherited parent transcript before it is injected into a
 * tool-less advisor consult subagent.
 *
 * `Conversation.injectInheritedContext` injects the parent's messages VERBATIM
 * with no sanitization, so the advisor path must run this over the parent
 * messages before they are injected.
 *
 * Strips blocks the advisor shouldn't (or can't) replay:
 *  - thinking / redacted-thinking (the advisor tool drops thinking),
 *  - files,
 *  - `server_tool_use` AND `web_search_tool_result` — provider-side tool calls
 *    (e.g. web search) and their results are dropped *together*. Dropping the
 *    result without its paired `server_tool_use` would leave an orphaned call
 *    block the provider rejects, so any consult after prior web-search history
 *    would fail; dropping both keeps the sequence valid.
 *
 * Images are preserved — top-level and nested inside `tool_result.contentBlocks`
 * (which are recursively sanitized) — so the advisor sees what the executor saw.
 * Visual tasks depend on it; the advisor profile is expected to be vision-capable.
 *
 * It also strips the *pending* client tool calls from the final assistant turn:
 * at capture time the last assistant message can carry a `tool_use` with no
 * matching `tool_result` yet, so sending it would be a dangling call. Earlier,
 * completed `tool_use` / `tool_result` pairs are preserved intact.
 *
 * In-flight-turn parity — ensuring the assistant's just-written plan from the
 * current turn is included while its dangling tool_use is stripped — is handled
 * by the consumer (the wiring that calls this before injection); this function
 * only strips a dangling `tool_use` IF it appears on the final assistant turn.
 */

import type { ContentBlock, Message } from "../providers/types.js";

/** Drop disallowed blocks; recursively sanitize tool_result content. `null` = drop. */
function sanitize(block: ContentBlock): ContentBlock | null {
  switch (block.type) {
    case "thinking":
    case "redacted_thinking":
    case "file":
    case "server_tool_use":
    case "web_search_tool_result":
      return null;
    case "tool_result": {
      if (!block.contentBlocks) return block;
      // Keep images (and other allowed blocks) nested in the tool result; drop
      // the disallowed ones.
      const contentBlocks = block.contentBlocks
        .map(sanitize)
        .filter((b): b is ContentBlock => b !== null);
      return {
        ...block,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      };
    }
    default:
      // text, image, tool_use — kept.
      return block;
  }
}

export function sanitizeConsultTranscript(
  messages: ReadonlyArray<Message>,
): Message[] {
  const out: Message[] = [];
  const lastIndex = messages.length - 1;

  messages.forEach((message, index) => {
    let content = message.content
      .map(sanitize)
      .filter((b): b is ContentBlock => b !== null);

    // The final assistant turn's client tool calls have no results yet — drop
    // them so we never send a dangling tool_use. (server_tool_use is already
    // dropped above.)
    if (index === lastIndex && message.role === "assistant") {
      content = content.filter(
        (b) => b.type !== "tool_use" && b.type !== "server_tool_use",
      );
    }

    if (content.length > 0) out.push({ role: message.role, content });
  });

  return out;
}
