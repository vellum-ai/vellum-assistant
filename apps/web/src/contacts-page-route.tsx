import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useConversationStore } from "@/stores/conversation-store";
import { ContactsPage } from "@/domains/contacts/contacts-page";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/utils/conversation-draft-id";
import { routes } from "@/utils/routes";

export function ContactsPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();

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
