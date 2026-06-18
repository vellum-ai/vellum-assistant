import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { LibraryView } from "@/domains/library/library-view";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

export function LibraryPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleNewConversation = useCallback(
    (initialMessage?: string) => {
      navigateToNewConversation(navigate, { prompt: initialMessage });
    },
    [navigate],
  );

  const handleOpenDocument = useCallback(
    (documentSurfaceId: string) => {
      void navigate(routes.document(documentSurfaceId));
    },
    [navigate],
  );

  // Clicking an app navigates to /assistant/library/:appId, where
  // LibraryDetailPage handles the dedicated load/render/error UI.
  const handleOpenApp = useCallback(
    (appIdToOpen: string) => {
      void navigate(routes.library.app(appIdToOpen));
    },
    [navigate],
  );

  return (
    <PageShell>
      <LibraryView
        assistantId={assistantId}
        title="Library"
        onNewConversation={handleNewConversation}
        onOpenDocument={handleOpenDocument}
        onOpenApp={handleOpenApp}
      />
    </PageShell>
  );
}
