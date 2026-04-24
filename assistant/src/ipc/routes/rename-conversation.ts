import { z } from "zod";

import { renameConversation } from "../../daemon/handlers/conversations.js";
import { buildAssistantEvent } from "../../runtime/assistant-event.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { getLogger } from "../../util/logger.js";
import type { IpcRoute } from "../assistant-server.js";

const log = getLogger("ipc:rename-conversation");

const RenameConversationParams = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1),
});

export const renameConversationRoute: IpcRoute = {
  method: "rename_conversation",
  handler: async (params) => {
    const { conversationId, title } = RenameConversationParams.parse(params);
    const success = renameConversation(conversationId, title);
    if (!success) {
      return { ok: false, error: `Conversation ${conversationId} not found` };
    }

    // Broadcast events so connected clients update in real time.
    assistantEventHub
      .publish(
        buildAssistantEvent(
          DAEMON_INTERNAL_ASSISTANT_ID,
          {
            type: "conversation_title_updated",
            conversationId,
            title,
          },
          conversationId,
        ),
      )
      .catch((err) => {
        log.warn({ err }, "Failed to publish conversation_title_updated");
      });

    assistantEventHub
      .publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "conversation_list_invalidated",
          reason: "renamed",
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "Failed to publish conversation_list_invalidated for rename",
        );
      });

    return { ok: true };
  },
};
