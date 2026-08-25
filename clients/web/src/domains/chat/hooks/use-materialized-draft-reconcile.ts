/**
 * Retire draft conversation keys the server has since written a row for.
 *
 * A draft key is a client invention: `draftConversationIds` marks the ids that
 * name nothing server-side, so surfaces can tell "empty because brand new"
 * apart from "empty because history is still loading". The mark must come off
 * the instant a row exists and never before, because a key wrongly treated as
 * persisted loads history that 404s and resolves its billing profile from a
 * row that is not there.
 *
 * The conversation list is the one signal that answers "does the row exist"
 * with the server's own answer. The text path has a closer one and keeps it:
 * its POST returns the resolved id, so `use-send-message` clears on the spot.
 * A live-voice turn writes its row inside the daemon with no response for the
 * client to read, leaving nothing local to key on. Intersecting the draft set
 * with the fetched list covers that path, and self-heals any key whose own
 * clear was missed.
 *
 * Fetched, not promised: a frame announcing an imminent turn is not a row.
 * The daemon publishes a `conversationsList` invalidation as it creates one
 * (`defaultStartVoiceTurn`), the sync hook refreshes the list windows, and a
 * key that shows up in the result is a key with a row behind it. A session
 * that ends without ever writing one leaves its draft mark alone forever,
 * which is what keeps the empty state and the fresh composer correct.
 */

import { useEffect } from "react";

import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";

/**
 * Clear the draft mark from every id in `conversationIds` that carries one.
 *
 * Guarded on membership so the common case (nothing minted, or a list of rows
 * none of which is a draft) touches the store not at all.
 */
export function reconcileMaterializedDrafts(
  conversationIds: Iterable<string>,
): void {
  const { draftConversationIds, clearDraftConversationId } =
    useConversationStore.getState();
  if (draftConversationIds.size === 0) {
    return;
  }
  for (const conversationId of conversationIds) {
    if (draftConversationIds.has(conversationId)) {
      clearDraftConversationId(conversationId);
    }
  }
}

/**
 * Run {@link reconcileMaterializedDrafts} over each fetched conversation list.
 *
 * Mounted in `ChatLayout`, which already subscribes to the foreground list for
 * the sidebar, so this adds no request of its own and runs on exactly the
 * edges that matter: a refetch triggered by the daemon's create invalidation
 * hands back a new array, and the row it just added is in it.
 */
export function useMaterializedDraftReconcile(
  conversations: Conversation[],
): void {
  useEffect(() => {
    reconcileMaterializedDrafts(
      conversations.map((conversation) => conversation.conversationId),
    );
  }, [conversations]);
}
