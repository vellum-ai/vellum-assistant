import type { ConversationTransportMetadata } from "./message-types/conversations.js";

/**
 * Build transport hints from conversation transport metadata.
 *
 * Only forwards client-provided hints. Interface identity is already
 * covered by `<turn_context>`, and host environment fields (home dir,
 * username) are rendered in the `<workspace>` block.
 */
export function buildTransportHints(
  transport: ConversationTransportMetadata,
): string[] {
  return transport.hints ? [...transport.hints] : [];
}
