import { z } from "zod";

import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import type { IpcRoute } from "../cli-server.js";

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
    return wakeAgentForOpportunity({ conversationId, hint, source });
  },
};
