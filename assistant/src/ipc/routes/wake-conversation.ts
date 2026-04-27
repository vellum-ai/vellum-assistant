import { z } from "zod";

import { getConversation } from "../../memory/conversation-crud.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import type { IpcRoute } from "../assistant-server.js";

const WakeConversationParams = z.object({
  conversationId: z.string().min(1),
  hint: z.string().min(1),
  source: z.string().default("cli"),
});

export const wakeConversationRoute: IpcRoute = {
  method: "wake_conversation",
  handler: async (params) => {
    const { conversationId, hint, source } =
      WakeConversationParams.parse(params);

    const conversation = getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    return wakeAgentForOpportunity({ conversationId, hint, source });
  },
};
