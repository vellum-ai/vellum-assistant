/**
 * Rename a conversation.
 *
 * POST /v1/conversations/rename
 *
 * Accepts { conversationId, title } in the body, renames the conversation,
 * and broadcasts real-time events so connected clients update.
 */

import {
  getConversation,
  updateConversationTitle,
} from "../../memory/conversation-crud.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("rename-conversation-routes");

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "rename_conversation",
    endpoint: "conversations/rename",
    method: "POST",
    summary: "Rename a conversation",
    description: "Update the display title of a conversation.",
    tags: ["conversations"],
    handler: ({ body }) => {
      const conversationId = body?.conversationId;
      const title = body?.title;

      if (
        !conversationId ||
        typeof conversationId !== "string" ||
        !title ||
        typeof title !== "string"
      ) {
        throw new BadRequestError("conversationId and title are required");
      }

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(
          `Conversation ${conversationId} not found`,
        );
      }

      updateConversationTitle(conversationId, title, 0);

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
  },
];
