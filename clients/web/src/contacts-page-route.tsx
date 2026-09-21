import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ContactsPage } from "@/domains/contacts/contacts-page";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { returnToList } from "@/utils/list-detail-navigation";
import { routes } from "@/utils/routes";

export function ContactsPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const { contactId } = useParams<{ contactId: string }>();
  const { state: locationState } = useLocation();
  const previousAssistantId = useRef(assistantId);

  // The contact id in the URL belongs to one assistant, and the host switches
  // assistants without navigating, so an id left over from the assistant being
  // left names nothing under the one arriving. The detail route leaves for the
  // list the same way its Back does, so an entry pushed from the list pops
  // rather than stacking a second copy of the list ahead of it. A deep link
  // into the assistant already active is untouched, because the first render
  // records the id rather than acting on it.
  useEffect(() => {
    const previous = previousAssistantId.current;
    previousAssistantId.current = assistantId;
    if (previous === assistantId || !contactId) {
      return;
    }
    returnToList(navigate, locationState, routes.contacts.root);
  }, [assistantId, contactId, locationState, navigate]);

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
