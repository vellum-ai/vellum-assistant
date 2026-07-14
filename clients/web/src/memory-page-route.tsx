import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { MemoryPage } from "@/domains/intelligence/memory-page";
import { navigateToNewConversation } from "@/utils/conversation-navigation";

export function MemoryPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();

  return (
    <MemoryPage
      key={assistantId}
      onOpenThread={(message) => {
        navigateToNewConversation(navigate, { prompt: message });
      }}
    />
  );
}
