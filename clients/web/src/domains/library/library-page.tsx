import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { LibraryView } from "@/domains/library/library-view";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function LibraryPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleNewConversation = useCallback(
    (initialMessage?: string) => {
      useViewerStore.getState().setMainView("chat");
      const draftId = crypto.randomUUID();
      useConversationStore.getState().setActiveConversationId(draftId);
      let path = routes.conversation(draftId);
      if (initialMessage) {
        path = `${path}?${new URLSearchParams({ prompt: initialMessage }).toString()}`;
      }
      void navigate(path);
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
