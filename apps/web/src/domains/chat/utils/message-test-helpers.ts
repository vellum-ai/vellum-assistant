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
        textSegments: [{ type: "text", content }],
        contentOrder: [{ type: "text", id: "0" }],
      }
    : { textSegments: [], contentOrder: [] };
}
