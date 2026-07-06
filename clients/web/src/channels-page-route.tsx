import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ChannelsPage } from "@/domains/contacts/channels-page";
import { navigateToNewConversation } from "@/utils/conversation-navigation";

export function ChannelsPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();

  return (
    <ChannelsPage
      key={assistantId}
      assistantId={assistantId}
      onStartSetupConversation={(prompt) => {
        navigateToNewConversation(navigate, { prompt });
      }}
    />
  );
}
