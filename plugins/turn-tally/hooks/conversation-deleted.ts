/**
 * `conversation-deleted` hook: purges the deleted conversation's tally
 * rows so derived data does not outlive the conversation that produced
 * it. By the time this fires the conversation's own rows are already
 * gone; the id is the only key needed.
 */

import type {
  ConversationDeletedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import { purgeConversation } from "../src/tally-store.js";

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (
  ctx,
) => {
  const removed = purgeConversation(ctx.conversationId);
  if (removed > 0) {
    ctx.logger.info({ removed }, "purged turn-tally rows");
  }
};

export default conversationDeleted;
