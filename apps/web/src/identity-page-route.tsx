import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useConversationStore } from "@/stores/conversation-store";
import { IdentityPage } from "@/domains/intelligence/identity-page";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/utils/conversation-draft-id";
import { routes } from "@/utils/routes";

export function IdentityPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();

  return (
    <IdentityPage
      key={assistantId}
      onOpenThread={(message) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = createDraftConversationId();
        useConversationStore.getState().setActiveConversationId(draftConversationId);
        void navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(message)}`,
        );
      }}
    />
  );
}
