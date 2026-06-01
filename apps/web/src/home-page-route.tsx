import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";

import { Typography } from "@vellum/design-library";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationListQuery } from "@/domains/conversations/conversation-queries";
import { useConversationStore } from "@/stores/conversation-store";
import { HomePage } from "@/domains/home/home-page";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function HomePageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const isMobile = useIsMobile();
  const { conversations } = useConversationListQuery(assistantId);
  const validConversationIds = useMemo(
    () => new Set(conversations.map((c) => c.conversationId)),
    [conversations],
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
        const draftConversationId = createDraftConversationId();
        useConversationStore.getState().setActiveConversationId(draftConversationId);
        navigate(routes.conversation(draftConversationId));
        requestComposerFocus();
      }}
      onOpenConversation={(conversationId) =>
        navigate(routes.conversation(conversationId))
      }
      onSuggestionSelected={(prompt) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = createDraftConversationId();
        useConversationStore.getState().setActiveConversationId(draftConversationId);
        navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
        );
      }}
    />
  );
}
