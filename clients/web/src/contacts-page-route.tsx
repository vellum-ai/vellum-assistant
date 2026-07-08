import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ContactsPage } from "@/domains/contacts/contacts-page";
import { navigateToNewConversation } from "@/utils/conversation-navigation";

export function ContactsPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();

  return (
    <ContactsPage
      key={assistantId}
      assistantId={assistantId}
      onStartSetupConversation={(prompt) => {
        navigateToNewConversation(navigate, { prompt });
      }}
    />
  );
}
