/**
 * Default `memory` message-deleted hook.
 *
 * Stamps the conversation's retrospective cursor with the deleted row's
 * `createdAt` when the cursor points at that row and was written without a
 * timestamp (by a build before the column existed). The cursor usually sits
 * on the latest assistant reply, which is exactly the row a regenerate
 * deletes, and once the row is gone only the timestamp can place it.
 */

import type { HookFunction, MessageDeletedContext } from "@vellumai/plugin-api";

import { preserveRetrospectiveCursorTimestamps } from "../memory-retrospective-cursor-preserve.js";

const messageDeleted: HookFunction<MessageDeletedContext> = async (ctx) => {
  await preserveRetrospectiveCursorTimestamps(ctx.conversationId, [
    { id: ctx.messageId, createdAt: ctx.createdAt },
  ]);
};

export default messageDeleted;
