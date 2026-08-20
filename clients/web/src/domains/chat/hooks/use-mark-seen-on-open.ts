import { useEffect, useRef } from "react";

import { useMarkConversationSeenMutation } from "@/domains/chat/hooks/use-mark-conversation-seen-mutation";
import type { AssistantState } from "@/assistant/types";
import type { Conversation } from "@/types/conversation-types";

/**
 * Marks the active conversation as seen when the user opens it and it has
 * unseen assistant messages.
 *
 * The write itself belongs to `useMarkConversationSeenMutation`, shared with
 * the explicit "Mark as read" action, so opening a conversation and choosing
 * the menu item produce identical cache effects. This hook owns only the
 * decision to fire: which conversation, and not twice for the same one.
 *
 * This is a conversation lifecycle action (changing seen-state), not
 * attention tracking — it lives here because its concern is state
 * mutation, not observation.
 *
 * Seen means the user saw it, so the caller says whether the transcript is on
 * screen. The selected conversation is not the same as a visible one: it
 * outlives the route it was selected on, and the viewer can cover it on that
 * route. A message arriving in either case is unread until the user returns.
 */
export function useMarkSeenOnOpen({
  assistantId,
  assistantStateKind,
  activeConversationId,
  activeConversation,
  isTranscriptOnScreen,
}: {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
  activeConversationId: string | null;
  activeConversation: Conversation | undefined;
  isTranscriptOnScreen: boolean;
}) {
  const { mutate: markSeen } = useMarkConversationSeenMutation();
  const lastSeenOnOpenConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId ||
      !isTranscriptOnScreen
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

    markSeen(
      { assistantId, conversationId: activeConversationId },
      {
        // Releasing the guard on settle (not only on success) lets a failed
        // write be retried the next time the effect re-evaluates; the
        // mutation has already rolled its optimistic patch back by then.
        onSettled: () => {
          lastSeenOnOpenConversationIdRef.current = null;
        },
      },
    );
    // `markSeen` is a stable reference from TanStack Query, so listing it
    // does not re-run this effect.
  }, [
    activeConversation,
    activeConversationId,
    assistantId,
    assistantStateKind,
    isTranscriptOnScreen,
    markSeen,
  ]);
}
