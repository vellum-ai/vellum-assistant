import { createConversation } from "./conversation-crud.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
  type TitleOrigin,
} from "./conversation-title-service.js";

export interface BootstrapConversationOptions {
  conversationType?: "standard" | "background" | "scheduled";
  source?: string;
  origin: TitleOrigin;
  systemHint: string;
  scheduleJobId?: string;
  groupId?: string;
  /**
   * When set, the new conversation is linked to its parent via the
   * `fork_parent_conversation_id` column. Used by background jobs that
   * spawn analysis conversations off a source conversation (auto-analyze,
   * memory-retrospective) so the parent → child relationship is queryable
   * later (e.g. "find the most recent retrospective for this source").
   */
  forkParentConversationId?: string;
}

export function bootstrapConversation(opts: BootstrapConversationOptions) {
  const conversation = createConversation({
    title: GENERATING_TITLE,
    ...(opts.conversationType && { conversationType: opts.conversationType }),
    ...(opts.source && { source: opts.source }),
    ...(opts.scheduleJobId && { scheduleJobId: opts.scheduleJobId }),
    ...(opts.groupId && { groupId: opts.groupId }),
    ...(opts.forkParentConversationId && {
      forkParentConversationId: opts.forkParentConversationId,
    }),
  });
  queueGenerateConversationTitle({
    conversationId: conversation.id,
    context: { origin: opts.origin, systemHint: opts.systemHint },
  });
  return conversation;
}
