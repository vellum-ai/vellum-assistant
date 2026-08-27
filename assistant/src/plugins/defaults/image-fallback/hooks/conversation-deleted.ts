/**
 * Default `conversation-deleted` hook: removes the deleted conversation's rows
 * from the plugin-owned store, cached captions and indexed images alike, so
 * derived data does not outlive the conversation whose images produced it. A
 * caption shared with a surviving conversation stays resolvable through that
 * conversation's rows.
 */

import {
  type ConversationDeletedContext,
  type HookFunction,
} from "@vellumai/plugin-api";

import { deleteConversationCaptions } from "../src/caption-cache.js";
import { deleteConversationImages } from "../src/image-index.js";

const conversationDeleted: HookFunction<ConversationDeletedContext> = async (
  ctx,
) => {
  const removed = deleteConversationCaptions(ctx.conversationId);
  const removedImages = deleteConversationImages(ctx.conversationId);
  if (removed > 0 || removedImages > 0) {
    ctx.logger.info(
      { plugin: "image-fallback", removed, removedImages },
      "Removed deleted conversation's cached image captions and image index",
    );
  }
};

export default conversationDeleted;
