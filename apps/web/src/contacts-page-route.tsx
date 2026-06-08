import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { startDraftConversation } from "@/domains/chat/utils/conversation-selection";
import { ContactsPage } from "@/domains/contacts/contacts-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function ContactsPageRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  return (
    <ContactsPage
      key={assistantId}
      assistantId={assistantId}
      onStartSetupConversation={(prompt) => {
        useViewerStore.getState().setMainView("chat");
        const draftConversationId = startDraftConversation(queryClient, assistantId);
        void navigate(
          `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
        );
      }}
    />
  );
}
