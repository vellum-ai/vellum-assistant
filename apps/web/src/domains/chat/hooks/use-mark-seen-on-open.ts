import { captureError } from "@/lib/sentry/capture-error";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { markConversationSeenLocal } from "@/utils/conversation-cache-mutations";
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
    if (assistantStateKind !== "active" || !assistantId || !activeConversationId) return;
    if (!activeConversation) return;
    if (!activeConversation.hasUnseenLatestAssistantMessage) return;
    if (lastSeenOnOpenConversationIdRef.current === activeConversationId) return;

    lastSeenOnOpenConversationIdRef.current = activeConversationId;

    let cancelled = false;

    conversationsSeenPost({
      path: { assistant_id: assistantId },
      body: { conversationId: activeConversationId },
      throwOnError: true,
    })
      .then(() => {
        if (cancelled) return;
        markConversationSeenLocal(queryClient, assistantId, activeConversationId);
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
