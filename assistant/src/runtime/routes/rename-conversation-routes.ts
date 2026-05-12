/**
 * Rename a conversation.
 *
 * POST /v1/conversations/rename
 *
 * Accepts { conversationId, title } in the body, renames the conversation,
 * and broadcasts real-time events so connected clients update.
 */

import { z } from "zod";

import {
  getConversation,
  updateConversationTitle,
} from "../../memory/conversation-crud.js";
import { publishConversationTitleChanged } from "../sync/resource-sync-events.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const RenameConversationBody = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "rename_conversation",
    endpoint: "conversations/rename",
    method: "POST",
    summary: "Rename a conversation",
    description: "Update the display title of a conversation.",
    tags: ["conversations"],
    requestBody: RenameConversationBody,
    handler: ({ body }) => {
      const parsed = RenameConversationBody.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestError("conversationId and title are required");
      }

      const { conversationId, title } = parsed.data;

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(`Conversation ${conversationId} not found`);
      }

      updateConversationTitle(conversationId, title, 0);

      publishConversationTitleChanged(conversationId, title);

      return { ok: true };
    },
  },
];
