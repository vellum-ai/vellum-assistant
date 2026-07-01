import { conversationMessagesSyncTag } from "../../daemon/message-types/sync.js";
import type { MessageReaction } from "../../persistence/conversation-crud.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

/**
 * Broadcast the typed `message_reaction_updated` event (full replacement
 * set, patches the row in place on live clients) plus the `sync_changed`
 * messages tag as the catch-up signal for clients that missed it.
 *
 * Lives in its own module (not `resource-sync-events.ts`) because it is
 * imported by the `send_reaction` tool: the resource-sync-events helpers
 * pull in daemon handler modules that cycle back into the tool manifest
 * when a tool file is the module-graph entry.
 */
export function publishMessageReactionUpdated(
  conversationId: string,
  messageId: string,
  reactions: MessageReaction[],
  originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "message_reaction_updated",
      conversationId,
      messageId,
      reactions,
    },
    conversationId,
  );
  void publishSyncInvalidation(
    [conversationMessagesSyncTag(conversationId)],
    originClientId,
  );
}
