/**
 * Transport-agnostic route for exporting a conversation with all messages.
 *
 * GET /v1/conversations/:id/export — Return the full conversation for export.
 * Supports prefix matching on conversation ID.
 */

import { getConversation, getMessages } from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

export const CONVERSATION_EXPORT_ROUTES: RouteDefinition[] = [
  {
    operationId: "conversation_export",
    endpoint: "conversations/:id/export",
    method: "GET",
    policyKey: "conversations",
    summary: "Export a conversation",
    description:
      "Return the full conversation with all messages for export. Supports prefix matching on conversation ID.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "string" }],
    handler: ({ pathParams }: RouteHandlerArgs) => {
      const rawId = pathParams!.id;
      const resolvedId = resolveConversationId(rawId);
      if (!resolvedId) throw new NotFoundError(`Conversation ${rawId} not found`);
      const conversation = getConversation(resolvedId);
      if (!conversation) throw new NotFoundError(`Conversation ${rawId} not found`);
      const messages = getMessages(resolvedId);
      return {
        ok: true,
        conversation: {
          id: conversation.id,
          title: conversation.title ?? null,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        messages: messages.map((m) => ({
          role: m.role,
          content: JSON.parse(m.content) as unknown[],
          createdAt: m.createdAt,
        })),
      };
    },
  },
];
