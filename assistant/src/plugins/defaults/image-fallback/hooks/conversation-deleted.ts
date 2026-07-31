/**
 * Default `conversation-deleted` hook: removes the deleted conversation's
 * rows from the plugin-owned caption store, so derived caption text does not
 * outlive the conversation whose images produced it. A caption shared with a
 * surviving conversation stays resolvable through that conversation's rows.
 */

import {
  type ConversationDeletedContext,
  type HookFunction,
} from "@vellumai/plugin-api";

import { deleteConversationCaptions } from "../src/caption-cache.js";

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (
  ctx,
) => {
  const removed = deleteConversationCaptions(ctx.conversationId);
  if (removed > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", removed },
      "Removed deleted conversation's cached image captions",
    );
  }
};

export default conversationDeleted;
