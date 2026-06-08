import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { startDraftConversation } from "@/domains/chat/utils/conversation-selection";
import { IdentityPage } from "@/domains/intelligence/identity-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function IdentityPageRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  return (
    <IdentityPage
      key={assistantId}
      onOpenThread={(message) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = startDraftConversation(queryClient, assistantId);
        void navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(message)}`,
        );
      }}
    />
  );
}
