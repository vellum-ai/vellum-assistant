import { createConversation } from "./conversation-crud.js";
import {
  AUTO_TITLE_DETERMINISTIC,
  deriveDeterministicTitle,
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

/**
 * Create a system-initiated conversation with a deterministic title derived
 * from `systemHint` — no LLM call. Background conversations (heartbeat runs,
 * scheduled jobs, subagents, retrospectives) are created in bulk and rarely
 * read by name, so an LLM-generated title is not worth the tokens. The title
 * is persisted with `AUTO_TITLE_DETERMINISTIC`, which keeps it replaceable:
 * if a user ever sends a message in the conversation, the title-generate
 * hook upgrades it to an LLM title (see
 * `plugins/defaults/title-generate/hooks/user-prompt-submit.ts`).
 */
export function bootstrapConversation(opts: BootstrapConversationOptions) {
  return createConversation({
    title: deriveDeterministicTitle({
      origin: opts.origin,
      systemHint: opts.systemHint,
    }),
    isAutoTitle: AUTO_TITLE_DETERMINISTIC,
    ...(opts.conversationType && { conversationType: opts.conversationType }),
    ...(opts.source && { source: opts.source }),
    ...(opts.scheduleJobId && { scheduleJobId: opts.scheduleJobId }),
    ...(opts.groupId && { groupId: opts.groupId }),
    ...(opts.forkParentConversationId && {
      forkParentConversationId: opts.forkParentConversationId,
    }),
  });
}
