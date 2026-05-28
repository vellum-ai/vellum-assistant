import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";
import { IdentityPage } from "@/domains/intelligence/identity-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function IdentityPageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();

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
