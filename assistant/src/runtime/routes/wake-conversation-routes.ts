/**
 * Wake a conversation's agent loop with an opportunity hint.
 *
 * POST /v1/conversations/wake
 */

import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import { wakeAgentForOpportunity } from "../agent-wake.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const WakeConversationBody = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "wake_conversation",
    endpoint: "conversations/wake",
    method: "POST",
    summary: "Wake a conversation",
    description:
      "Invoke the agent loop for a conversation with an opportunity hint.",
    tags: ["conversations"],
    requestBody: WakeConversationBody,
    responseBody: z.object({
      invoked: z.boolean(),
      producedToolCalls: z.boolean(),
      reason: z.string().optional(),
    }),
    handler: async ({ body }) => {
      const { conversationId, hint, source } =
        WakeConversationBody.parse(body);

      const conversation = getConversation(conversationId);
      if (!conversation) {
        throw new NotFoundError(
          `Conversation not found: ${conversationId}`,
        );
      }

      return wakeAgentForOpportunity({ conversationId, hint, source });
    },
  },
];
