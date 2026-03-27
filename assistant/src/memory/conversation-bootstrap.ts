import { createConversation } from "./conversation-crud.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
  type TitleOrigin,
} from "./conversation-title-service.js";

export interface BootstrapConversationOptions {
  conversationType?: "standard" | "private" | "background";
  source?: string;
  origin: TitleOrigin;
  systemHint: string;
  scheduleJobId?: string;
  groupId?: string;
}

export function bootstrapConversation(opts: BootstrapConversationOptions) {
  const conversation = createConversation({
    title: GENERATING_TITLE,
    ...(opts.conversationType && { conversationType: opts.conversationType }),
    ...(opts.source && { source: opts.source }),
    ...(opts.scheduleJobId && { scheduleJobId: opts.scheduleJobId }),
    ...(opts.groupId && { groupId: opts.groupId }),
  });
  queueGenerateConversationTitle({
    conversationId: conversation.id,
    context: { origin: opts.origin, systemHint: opts.systemHint },
  });
  return conversation;
}
