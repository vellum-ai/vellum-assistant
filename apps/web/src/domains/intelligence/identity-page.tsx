import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/components/layout/active-assistant-gate.js";
import { createDraftConversationKey } from "@/domains/chat/utils/conversation-selection.js";
import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import { IdentityTab } from "@/domains/intelligence/components/identity-tab.js";
import { routes } from "@/utils/routes.js";
import { useViewerStore } from "@/stores/viewer-store.js";

export function IdentityPage() {
  const { assistantId } = useActiveAssistantContext();
  const navigate = useNavigate();

  const handleOpenThread = useCallback(
    (message: string) => {
      useViewerStore.getState().setMainView("chat");
      const draftKey = createDraftConversationKey();
      useConversationStore.getState().setActiveKey(draftKey);
      navigate(
        `${routes.conversation(draftKey)}?prompt=${encodeURIComponent(message)}`,
      );
    },
    [navigate],
  );

  return <IdentityTab assistantId={assistantId} onOpenThread={handleOpenThread} />;
}
