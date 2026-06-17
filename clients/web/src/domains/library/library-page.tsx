import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { LibraryView } from "@/domains/library/library-view";
import { routes } from "@/utils/routes";

export function LibraryPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleNewConversation = useCallback(
    (_initialMessage?: string) => {
      // TODO: initialMessage seeding requires cross-route state coordination
      // (e.g. a Zustand store or sessionStorage handoff). The platform passes
      // initialMessage directly via startNewConversation() in the same React
      // tree, but here the library is a separate route. For now we just
      // navigate to chat; the deploy-flow prompt handoff will come with the
      // broader cross-route state work.
      void navigate(routes.assistant);
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
