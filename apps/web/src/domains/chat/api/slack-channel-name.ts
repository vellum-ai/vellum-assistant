import { conversationsByConversationIdSlackchannelResolvePost } from "@/generated/daemon/sdk.gen";
import type { ConversationsByConversationIdSlackchannelResolvePostResponse } from "@/generated/daemon/types.gen";

export async function resolveSlackChannelName(
  assistantId: string,
  conversationId: string,
): Promise<ConversationsByConversationIdSlackchannelResolvePostResponse | null> {
  try {
    const { data, response } =
      await conversationsByConversationIdSlackchannelResolvePost({
        path: { assistant_id: assistantId, conversationId },
        throwOnError: false,
      });

    if (!response?.ok || !data) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
