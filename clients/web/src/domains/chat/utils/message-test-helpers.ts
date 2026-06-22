import type { ConversationMessage } from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";

/**
 * Translate the execution state a test wants into the wire fields the
 * `tool-call-status.ts` predicates read. `status` is not stored on the tool
 * call; tests express intent through this convenience and the tool-call
 * factories materialize the underlying `isError`/`result`/`completedAt`.
 */
export function toolCallStatusWireFields(
  status: "running" | "completed" | "error",
): Partial<ChatMessageToolCall> {
  switch (status) {
    case "running":
      return {};
    case "completed":
      return { completedAt: 1 };
    case "error":
      return { isError: true };
  }
}

/**
 * Derive the flat plain text of a message row from its `contentBlocks`.
 *
 * Mirrors how the app renders and reconciles message bodies, so tests assert
 * on the same derived text the production code uses rather than a redundant
 * stored string.
 */
export function messageText(
  message: Pick<DisplayMessage, "contentBlocks"> | undefined,
): string {
  return messagePlainText(message);
}

/**
 * Build a text row's `textSegments`, `contentOrder`, and `contentBlocks` all
 * in lockstep — the shape both the ingest boundary and the streaming updaters
 * produce for a row whose body is a single text block. An empty string yields
 * empty positional arrays and no blocks, matching a contentless row.
 */
export function textBody(
  content: string,
): Pick<DisplayMessage, "textSegments" | "contentOrder" | "contentBlocks"> {
  return content
    ? {
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
        contentBlocks: [{ type: "text", text: content }],
      }
    : { textSegments: [], contentOrder: [], contentBlocks: [] };
}

/**
 * Build a settled reasoning row's `thinkingSegments`, `contentOrder`, and
 * `contentBlocks` all in lockstep — the shape the ingest boundary
 * (`normalizeContentBlocks`) materializes for a row whose body is a run of
 * reasoning blocks. The i-th thinking block carries the same text as
 * `thinkingSegments[i]`, so the block-first thinking reader resolves each
 * `thinking:i` id from the block rather than the positional fallback.
 */
export function thinkingBodyWithBlocks(
  ...segments: string[]
): Pick<DisplayMessage, "thinkingSegments" | "contentOrder" | "contentBlocks"> {
  return {
    thinkingSegments: segments,
    contentOrder: segments.map((_, i) => ({ type: "thinking", id: String(i) })),
    contentBlocks: segments.map((thinking) => ({ type: "thinking", thinking })),
  };
}

/**
 * Build the wire-shape `textSegments` + `contentOrder` for a server message
 * whose body is a single text block. The wire contract encodes segments as
 * plain strings and content order as positional `"<type>:<index>"` strings.
 */
export function wireTextBody(
  content: string,
): Pick<ConversationMessage, "textSegments" | "contentOrder"> {
  return content
    ? { textSegments: [content], contentOrder: ["text:0"] }
    : { textSegments: [], contentOrder: [] };
}

/**
 * Build the wire-shape `thinkingSegments` + `contentOrder` for a server
 * message whose body is a single reasoning (thinking) block. Mirrors
 * `wireTextBody` for the reasoning content kind.
 */
export function wireThinkingBody(
  thinking: string,
): Pick<ConversationMessage, "thinkingSegments" | "contentOrder"> {
  return thinking
    ? { thinkingSegments: [thinking], contentOrder: ["thinking:0"] }
    : { thinkingSegments: [], contentOrder: [] };
}

/**
 * Build a server-shape history row (`ConversationMessage`) from a partial,
 * filling the fields the wire contract requires (`timestamp`, `attachments`).
 */
export function makeServerMessage(
  partial: Partial<ConversationMessage> &
    Pick<ConversationMessage, "id" | "role">,
): ConversationMessage {
  return { timestamp: "", attachments: [], ...partial };
}

/**
 * Encode epoch milliseconds as the wire contract's ISO-8601 `timestamp`
 * string. Round-trips through the client's timestamp parser back to the same
 * epoch value, so ordering assertions written against `ms` still hold.
 */
export function wireTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
