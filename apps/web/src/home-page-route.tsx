import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";

import { Typography } from "@vellum/design-library";
import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { useAssistantContext } from "@/components/layout/assistant-context";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationListQuery } from "@/domains/conversations/conversation-queries";
import { useConversationStore } from "@/domains/conversations/conversation-store";
import { HomePage } from "@/domains/home/home-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function HomePageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();
  const { setTopBarCenter } = useAssistantContext();
  const { conversations } = useConversationListQuery(assistantId);
  const validConversationIds = useMemo(
    () => new Set(conversations.map((c) => c.conversationId)),
    [conversations],
  );

  useEffect(() => {
    setTopBarCenter(
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
      >
        Home
      </Typography>,
    );
    return () => { setTopBarCenter(null); };
  }, [setTopBarCenter]);

  return (
    <HomePage
      assistantId={assistantId}
      validConversationIds={validConversationIds}
      onStartNewChat={() => navigate(routes.assistant)}
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
