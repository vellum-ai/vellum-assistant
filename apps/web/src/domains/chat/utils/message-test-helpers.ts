import type { ConversationMessage } from "@vellumai/assistant-api";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";

/**
 * Derive the flat plain text of a message row from its `textSegments`.
 *
 * Mirrors how the app renders and reconciles message bodies, so tests assert
 * on the same derived text the production code uses rather than a redundant
 * stored string.
 */
export function messageText(
  message: Pick<DisplayMessage, "textSegments"> | undefined,
): string {
  return segmentsToPlainText(message?.textSegments);
}

/**
 * Build the `textSegments` + `contentOrder` for a message whose body is a
 * single text block. An empty string yields empty arrays, matching a row with
 * no text content.
 */
export function textBody(
  content: string,
): Pick<DisplayMessage, "textSegments" | "contentOrder"> {
  return content
    ? {
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
      }
    : { textSegments: [], contentOrder: [] };
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
