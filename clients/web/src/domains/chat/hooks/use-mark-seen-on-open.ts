import { captureError } from "@/lib/sentry/capture-error";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  adjustUnreadCountCache,
  markConversationSeenLocal,
} from "@/utils/conversation-cache-mutations";
import { unreadConversationCountQueryKey } from "@/utils/conversation-list-fetchers";
import { contributesToUnreadCount } from "@/utils/conversation-predicates";
import { conversationsSeenPost } from "@/generated/daemon/sdk.gen";
import type { AssistantState } from "@/assistant/types";
import type { Conversation } from "@/types/conversation-types";

/**
 * Marks the active conversation as seen when the user opens it and it
 * has unseen assistant messages. Fires a single POST to the daemon and
 * patches the TanStack Query cache on success.
 *
 * This is a conversation lifecycle action (changing seen-state), not
 * attention tracking — it lives here because its concern is state
 * mutation, not observation.
 */
export function useMarkSeenOnOpen({
  assistantId,
  assistantStateKind,
  activeConversationId,
  activeConversation,
}: {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
  activeConversationId: string | null;
  activeConversation: Conversation | undefined;
}) {
  const queryClient = useQueryClient();
  const lastSeenOnOpenConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId
    ) {
      return;
    }
    if (!activeConversation) {
      return;
    }
    if (!activeConversation.hasUnseenLatestAssistantMessage) {
      return;
    }
    if (lastSeenOnOpenConversationIdRef.current === activeConversationId) {
      return;
    }

    lastSeenOnOpenConversationIdRef.current = activeConversationId;

    let cancelled = false;

    // Whether the row counts toward the unread badge, captured before the
    // POST resolves so the seen-state flip can't erase the answer.
    const contributedToUnreadCount =
      contributesToUnreadCount(activeConversation);

    conversationsSeenPost({
      path: { assistant_id: assistantId },
      body: { conversationId: activeConversationId },
      throwOnError: true,
    })
      .then(() => {
        if (cancelled) {
          return;
        }
        markConversationSeenLocal(
          queryClient,
          assistantId,
          activeConversationId,
        );
        // Drop the row's contribution from the unread-count cache
        // immediately, then refetch the authoritative value (the daemon
        // suppresses the self-originated sync echo, so no invalidation
        // arrives over SSE for this write).
        if (contributedToUnreadCount) {
          adjustUnreadCountCache(queryClient, assistantId, -1);
        }
        void queryClient.invalidateQueries({
          queryKey: unreadConversationCountQueryKey(assistantId),
        });
        lastSeenOnOpenConversationIdRef.current = null;
      })
      .catch((err) => {
        lastSeenOnOpenConversationIdRef.current = null;
        captureError(err, { context: "mark_conversation_seen" });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeConversation,
    activeConversationId,
    assistantId,
    assistantStateKind,
    queryClient,
  ]);
}
