import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { startDraftConversation } from "@/domains/chat/utils/conversation-selection";
import { HomePage } from "@/domains/home/home-page";
import {
    useBackgroundConversationListQuery,
    useConversationListQuery,
    useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useViewerStore } from "@/stores/viewer-store";
import { mergeConversationLists } from "@/utils/conversation-cache";
import { routes } from "@/utils/routes";
import { Typography } from "@vellumai/design-library";

export function HomePageRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const isMobile = useIsMobile();
  const { conversations: foregroundConversations } =
    useConversationListQuery(assistantId);
  // Recap/feed items can reference background and scheduled jobs, so the home
  // feed eagerly loads both lists to validate their "go to thread" links.
  // These queries are non-blocking — the page renders before they resolve.
  const { conversations: backgroundConversations } =
    useBackgroundConversationListQuery(assistantId, true);
  const { conversations: scheduledConversations } =
    useScheduledConversationListQuery(assistantId, true);
  const validConversationIds = useMemo(
    () =>
      new Set(
        mergeConversationLists(
          foregroundConversations,
          backgroundConversations,
          scheduledConversations,
        ).map((c) => c.conversationId),
      ),
    [foregroundConversations, backgroundConversations, scheduledConversations],
  );

  useEffect(() => {
    if (isMobile) {
      setTopBarCenter(
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-secondary)]"
        >
          Home
        </Typography>,
      );
    } else {
      setTopBarCenter(null);
    }
    return () => { setTopBarCenter(null); };
  }, [isMobile, setTopBarCenter]);

  return (
    <HomePage
      assistantId={assistantId}
      validConversationIds={validConversationIds}
      onStartNewChat={() => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = startDraftConversation(queryClient, assistantId);
        navigate(routes.conversation(draftConversationId));
        requestComposerFocus();
      }}
      onOpenConversation={(conversationId) =>
        navigate(routes.conversation(conversationId))
      }
      onSuggestionSelected={(prompt) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = startDraftConversation(queryClient, assistantId);
        navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
        );
      }}
    />
  );
}
