import { useEffect } from "react";
import * as Sentry from "@sentry/react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";

/**
 * How long parked emails may wait for their conversation to come on screen.
 * A park that never drained (its navigation bounced off a route guard, say)
 * must not surface in a composer opened minutes later for something else.
 */
export const PENDING_COMPOSER_EMAILS_TTL_MS = 60_000;

export interface UsePendingEmailReferencesOptions {
  activeConversationId: string | null;
}

/**
 * Chat-domain half of the inbox's "Start a new chat" over a selection:
 * stages the emails `AssistantInboxPageRoute` parked once the draft it
 * minted for them is the active conversation.
 *
 * Addressed, not broadcast: the park names the conversation whose composer
 * takes the emails, and a composer bound to any other conversation spends
 * the park without staging, since the user has gone somewhere else with it.
 * The staging runs after the session store's switch into the draft has
 * reset the composer's attachments, which is the reason the inbox parks
 * rather than staging directly.
 */
export function usePendingEmailReferences({
  activeConversationId,
}: UsePendingEmailReferencesOptions): void {
  const pending = usePendingDeepLinkStore.use.pendingComposerEmails();

  useEffect(() => {
    if (pending === null || activeConversationId === null) {
      return;
    }
    const store = usePendingDeepLinkStore.getState();
    const breadcrumb = (outcome: string) => {
      Sentry.addBreadcrumb({
        category: "inbox",
        level: "info",
        message: `composerEmails ${outcome}`,
      });
    };

    if (activeConversationId !== pending.threadId) {
      store.consumePendingComposerEmails();
      breadcrumb("dropped: user landed in another conversation");
      return;
    }

    const parked = store.consumePendingComposerEmails();
    if (parked === null) {
      return;
    }
    if (Date.now() - parked.parkedAt > PENDING_COMPOSER_EMAILS_TTL_MS) {
      breadcrumb("dropped: park expired");
      return;
    }

    useComposerStore.getState().addEmailReferences(parked.emails);
    requestComposerFocus();
    breadcrumb("staged");
  }, [pending, activeConversationId]);
}
