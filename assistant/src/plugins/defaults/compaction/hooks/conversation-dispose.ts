/**
 * Default `conversation-dispose` hook: drop the conversation's
 * {@link ContextWindowManager} from the compaction module's per-conversation
 * store when the conversation is torn down.
 *
 * The compaction module owns the manager's lifetime — it builds the instance in
 * {@link createContextWindowManager} and releases it here — so conversation
 * teardown no longer reaches into the compaction internals to clean up. Disposal
 * is keyed on {@link ConversationDisposeContext.conversationId} and is a plain
 * store delete, idempotent for an already-released conversation.
 */

import type {
  ConversationDisposeContext,
  PluginHookFn,
} from "@vellumai/plugin-api";

import { disposeContextWindowManager } from "../manager-store.js";

const conversationDispose: PluginHookFn<ConversationDisposeContext> = async (
  ctx,
) => {
  disposeContextWindowManager(ctx.conversationId);
};

export default conversationDispose;
