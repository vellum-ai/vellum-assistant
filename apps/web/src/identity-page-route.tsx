import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection.js";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import { IdentityPage } from "@/domains/intelligence/identity-page.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { routes } from "@/utils/routes.js";

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
