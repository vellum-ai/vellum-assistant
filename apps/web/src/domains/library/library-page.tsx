import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { LibraryView } from "@/domains/intelligence/components/apps/library-view.js";
import { routes } from "@/utils/routes.js";

export function LibraryPage() {
  const { assistantId } = useAssistantContext();
  const navigate = useNavigate();

  const handleNewConversation = useCallback(
    (initialMessage?: string) => {
      void navigate(
        initialMessage
          ? `${routes.assistant}?message=${encodeURIComponent(initialMessage)}`
          : routes.assistant,
      );
    },
    [navigate],
  );

  if (!assistantId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      <LibraryView
        assistantId={assistantId}
        onNewConversation={handleNewConversation}
      />
    </div>
  );
}
