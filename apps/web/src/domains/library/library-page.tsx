import { useCallback } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import { LibraryView } from "@/domains/intelligence/components/apps/library-view.js";
import { routes } from "@/utils/routes.js";

export function LibraryPage() {
  const { assistantId } = useActiveAssistantContext();
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

  return (
    <LibraryView
      assistantId={assistantId}
      onNewConversation={handleNewConversation}
      onOpenDocument={handleOpenDocument}
    />
  );
}
