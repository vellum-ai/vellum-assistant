import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection.js";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import { HomePage } from "@/domains/home/home-page.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { routes } from "@/utils/routes.js";

export function HomePageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();
  return (
    <HomePage
      assistantId={assistantId}
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
