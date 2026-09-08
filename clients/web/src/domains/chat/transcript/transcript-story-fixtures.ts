import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

import type { MessageItem } from "./types";

/**
 * Build a text-row `MessageItem` for a transcript story: a `DisplayMessage`
 * whose body is the single-text-block shape the ingest boundary materializes
 * (`textBody` keeps `textSegments`, `contentOrder`, and `contentBlocks` in
 * lockstep). Shared by every transcript story file so fixture rows cannot
 * drift from the production shape.
 */
export function message(
  id: string,
  role: "user" | "assistant",
  text: string,
): MessageItem {
  const msg: DisplayMessage = { id, role, ...textBody(text) };
  return { kind: "message", key: id, message: msg };
}
