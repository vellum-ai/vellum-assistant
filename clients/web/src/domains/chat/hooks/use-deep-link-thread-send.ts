import { useEffect } from "react";
import * as Sentry from "@sentry/react";
import { useQuery } from "@tanstack/react-query";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";
import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import { ConversationNotFoundError } from "@/utils/fetch-conversation-detail";

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
  activeConversationId: string | null;
  /**
   * The active conversation is a confirmed server row (from any list cache
   * or the single-row fetch), not a client draft. `useConversationLoader`'s
   * `conversationExistsOnServer`.
   */
  conversationExistsOnServer: boolean;
  /**
   * The confirmed row is archived. The picker only offers live
   * conversations, so a target archived after it synced is not what the
   * user chose to send into; the daemon does not revive an archived thread
   * on send, so the message would land in a thread the user put away.
   */
  activeConversationArchived: boolean;
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
 *   target thread, the server has answered that the conversation does not
 *   exist, or the park has aged past {@link PENDING_THREAD_SEND_TTL_MS}.
 *   "Does not exist" is the single-row fetch's 404: `useActiveConversation`
 *   asks for any row no list cache holds, and a miss leaves that query
 *   errored with `ConversationNotFoundError`, which this hook reads. That is
 *   definitive in a way no list scan is: a list is a window, and a row
 *   absent from it may simply be past the loaded page. A target archived
 *   *after* the picker synced is found but demotes too, deliberately: the
 *   daemon does not revive an archived thread on send, so reviving it is
 *   worth a look before the message lands, and the conservative direction
 *   is the safe one.
 * - **degrades to the target's persisted draft** when the user has moved to
 *   a different thread while the request was still resolving. The active id
 *   is set synchronously in the same bus callback that parks the request,
 *   so "active thread is not the target" can only mean the user navigated
 *   away, never that navigation has not landed. The text goes into the
 *   *target* thread's saved draft (`saveDraft`), which survives reload and
 *   surfaces in that composer whenever they open it, and never into the
 *   composer they happen to be in, which would stage it one tap from the
 *   wrong conversation.
 * - **waits** otherwise (the single-row fetch is still in flight, or has not
 *   started). The effect re-runs as it settles.
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
  activeConversationId,
  conversationExistsOnServer,
  activeConversationArchived,
  sendMessage,
}: UseDeepLinkThreadSendOptions): void {
  const pending = usePendingDeepLinkStore.use.pendingThreadSend();
  // Read-only view of the target's single-row fetch (`fetchConversationDetail`
  // runs it through this same key). Disabled, so this never fetches; it only
  // reflects the outcome the active-conversation path already produced. An
  // errored query holding ConversationNotFoundError is the server saying the
  // target does not exist, which is what lets "not there" be a decision.
  const { error: rowError } = useQuery({
    ...conversationsByIdGetOptions({
      path: {
        assistant_id: assistantId ?? "",
        id: pending?.threadId ?? "",
      },
    }),
    enabled: false,
  });
  const targetConfirmedAbsent = rowError instanceof ConversationNotFoundError;

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
      if (activeConversationArchived) {
        demote("target conversation is archived");
        return;
      }
      const parked = store.consumePendingThreadSend();
      if (parked !== null) {
        void sendMessage(parked.message);
      }
      return;
    }
    if (targetConfirmedAbsent) {
      demote("server reports the target conversation does not exist");
    }
    // Otherwise the target is still resolving; wait for the next change.
  }, [
    pending,
    activeConversationId,
    conversationExistsOnServer,
    activeConversationArchived,
    targetConfirmedAbsent,
    sendMessage,
  ]);
}
