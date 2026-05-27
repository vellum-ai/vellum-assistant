import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/domains/conversations/conversation-store";
import { ContactsPage } from "@/domains/contacts/contacts-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function ContactsPageRoute() {
  const navigate = useNavigate();
  const { assistantId } = useActiveAssistantContext();

  return (
    <ContactsPage
      key={assistantId}
      assistantId={assistantId}
      onStartSetupConversation={(prompt) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = createDraftConversationId();
        useConversationStore.getState().setActiveConversationId(draftConversationId);
        void navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
        );
      }}
    />
  );
}
