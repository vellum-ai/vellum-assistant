import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";
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
 * - **degrades to a pre-fill in the target's composer** (the unproven-link
 *   contract: text staged, focus requested, nothing sent) when, on the
 *   target thread, the foreground list has loaded and does not contain it,
 *   or the park has aged past {@link PENDING_THREAD_SEND_TTL_MS}. The
 *   picker only ever offers foreground conversations, so absence from a
 *   loaded foreground list is definitive for anything an intent can name.
 *   (A target archived *after* the picker synced is absent too and also
 *   demotes, deliberately: reviving an archived chat is worth a look before
 *   the send, and the conservative direction is the safe one.)
 * - **degrades to the target's persisted draft** when the user has moved to
 *   a different thread while the request was still resolving. The active id
 *   is set synchronously in the same bus callback that parks the request,
 *   so "active thread is not the target" can only mean the user navigated
 *   away, never that navigation has not landed. The text goes into the
 *   *target* thread's saved draft (`saveDraft`), which survives reload and
 *   surfaces in that composer whenever they open it, and never into the
 *   composer they happen to be in, which would stage it one tap from the
 *   wrong conversation.
 * - **waits** otherwise (list still loading, single-row fetch in flight).
 *   The effect re-runs as those settle.
 *
 * Between them the three demotions guarantee the text is never dropped:
 * every exit from the parked state either sends it or leaves it in the
 * target thread's composer, immediately or on the next visit.
 *
 * Mounted in `ActiveChatView` after `useConversationLoader` and
 * `useSendMessage`, whose outputs it consumes. The on-target demotion reuses
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
    if (pending === null || activeConversationId === null) {
      return;
    }
    const store = usePendingDeepLinkStore.getState();
    const breadcrumb = (outcome: string) => {
      Sentry.addBreadcrumb({
        category: "deeplink",
        level: "info",
        message: `sendToThread ${outcome}`,
      });
    };

    if (activeConversationId !== pending.threadId) {
      // Moved away mid-resolve: keep the text where the intent aimed it.
      const parked = store.consumePendingThreadSend();
      if (parked !== null) {
        useComposerStore.getState().saveDraft(parked.threadId, parked.message);
        breadcrumb("saved as the target thread's draft: user navigated away");
      }
      return;
    }

    const demote = (reason: string) => {
      const parked = store.consumePendingThreadSend();
      if (parked === null) {
        return;
      }
      breadcrumb(`demoted to pre-fill: ${reason}`);
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
