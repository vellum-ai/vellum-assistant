import { useMemo } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationListQuery } from "@/domains/conversations/conversation-queries";
import { useConversationStore } from "@/stores/conversation-store";
import { HomePage } from "@/domains/home/home-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function HomePageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();
  const { conversations } = useConversationListQuery(assistantId);
  const validConversationIds = useMemo(
    () => new Set(conversations.map((c) => c.conversationId)),
    [conversations],
  );

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
