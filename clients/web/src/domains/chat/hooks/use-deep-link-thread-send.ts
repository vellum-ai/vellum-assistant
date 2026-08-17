import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";

/**
 * How long a parked send-into-thread request may wait for its target to
 * resolve before it degrades to a pre-fill. Matches the voice-start park's
 * bound and exists for the same reason: a request whose navigation bounced
 * off a route guard must not fire minutes later when the user opens that
 * thread by hand. The text is never dropped, only demoted to the composer.
 */
export const PENDING_THREAD_SEND_TTL_MS = 60_000;

export interface UseDeepLinkThreadSendOptions {
  assistantId: string | null;
  isAssistantActive: boolean;
  activeConversationId: string | null;
  /**
   * The active conversation is a confirmed server row (from any list cache
   * or the single-row fetch), not a client draft. `useConversationLoader`'s
   * `conversationExistsOnServer`.
   */
  conversationExistsOnServer: boolean;
  sendMessage: (content: string) => Promise<void>;
}

/**
 * Chat-domain half of a *proven* `deeplink.sendToThread`: fulfils the send
 * request `useGlobalDeepLinkConsumer` parked in `usePendingDeepLinkStore`
 * once the user has landed in the target thread and it is confirmed to exist.
 *
 * The confirmation is the whole point of the split. The send path treats an
 * id it does not know as a client draft and server-mints a new conversation
 * for it, so relaying blindly would let a stale Shortcuts pick (a chat
 * deleted since the picker cache last synced) send the message somewhere the
 * user never chose. This hook therefore:
 *
 * - **sends** when the active thread is the target and
 *   `conversationExistsOnServer` is true;
 * - **degrades to a pre-fill** (the unproven-link contract: text in the
 *   composer, focus requested, nothing sent) when the foreground list has
 *   loaded and does not contain the target, or when the park has aged past
 *   {@link PENDING_THREAD_SEND_TTL_MS}. The picker only ever offers
 *   foreground conversations, so absence from a loaded foreground list is
 *   definitive for anything an intent can name;
 * - **waits** otherwise (list still loading, single-row fetch in flight,
 *   navigation not landed yet). The effect re-runs as those settle.
 *
 * Mounted in `ActiveChatView` after `useConversationLoader` and
 * `useSendMessage`, whose outputs it consumes. The demotion reuses
 * `useDeepLinkConsumer`'s pre-fill path by re-parking the text as a composer
 * message, so the draft-overwrite rules live in one place.
 */
export function useDeepLinkThreadSend({
  assistantId,
  isAssistantActive,
  activeConversationId,
  conversationExistsOnServer,
  sendMessage,
}: UseDeepLinkThreadSendOptions): void {
  const pending = usePendingDeepLinkStore.use.pendingThreadSend();
  // Observing the foreground list is what lets "not there" be a decision
  // rather than a guess; TanStack dedupes this with ChatLayout's subscription.
  const {
    conversations,
    isPending: listPending,
    isError: listErrored,
  } = useConversationListQuery(assistantId, isAssistantActive);

  useEffect(() => {
    if (pending === null || activeConversationId !== pending.threadId) {
      return;
    }
    const store = usePendingDeepLinkStore.getState();
    const demote = (reason: string) => {
      const parked = store.consumePendingThreadSend();
      if (parked === null) {
        return;
      }
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message: `sendToThread demoted to pre-fill: ${reason}`,
      });
      store.setPendingComposerMessage(parked.message);
      requestComposerFocus();
    };

    if (Date.now() - pending.parkedAt > PENDING_THREAD_SEND_TTL_MS) {
      demote("park expired");
      return;
    }
    if (conversationExistsOnServer) {
      const parked = store.consumePendingThreadSend();
      if (parked !== null) {
        void sendMessage(parked.message);
      }
      return;
    }
    const listLoaded = !listPending && !listErrored;
    if (
      listLoaded &&
      !conversations.some((c) => c.conversationId === pending.threadId)
    ) {
      demote("target absent from the loaded conversation list");
    }
    // Otherwise the target is still resolving; wait for the next change.
  }, [
    pending,
    activeConversationId,
    conversationExistsOnServer,
    conversations,
    listPending,
    listErrored,
    sendMessage,
  ]);
}
