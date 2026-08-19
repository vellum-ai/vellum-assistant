import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useMarkConversationSeenMutation } from "@/domains/chat/hooks/use-mark-conversation-seen-mutation";
import { useViewerStore } from "@/stores/viewer-store";
import { isConversationPath } from "@/utils/routes";
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
 * Seen means the user saw it, so the conversation has to be on screen. The
 * selected conversation outlives the route it was selected on, because the
 * streams read the same field and need it to, and it can also sit behind a
 * full-width app on its own route. In both the user is somewhere else, and a
 * message that arrives there is unread until they come back.
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
  const { mutate: markSeen } = useMarkConversationSeenMutation();
  const lastSeenOnOpenConversationIdRef = useRef<string | null>(null);
  const { pathname } = useLocation();
  const mainView = useViewerStore.use.mainView();
  const isAppMinimized = useViewerStore.use.isAppMinimized();

  // A full-width app replaces the transcript; minimized, it is a strip over a
  // chat the user can still read.
  const isCoveredByApp = mainView === "app" && !isAppMinimized;
  const isOnScreen = isConversationPath(pathname) && !isCoveredByApp;

  useEffect(() => {
    if (
      assistantStateKind !== "active" ||
      !assistantId ||
      !activeConversationId ||
      !isOnScreen
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
    isOnScreen,
    markSeen,
  ]);
}
