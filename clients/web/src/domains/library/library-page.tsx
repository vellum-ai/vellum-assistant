import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { LibraryView } from "@/domains/library/library-view";
import { useNewLibraryDocument } from "@/domains/library/use-new-library-document";
import { useSupportsDocumentCreate } from "@/lib/backwards-compat/use-supports-document-create";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import {
  documentEntryState,
  documentEntryUrl,
} from "@/utils/document-navigation";

export function LibraryPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const location = useLocation();

  const handleNewConversation = useCallback(
    (initialMessage?: string) => {
      navigateToNewConversation(navigate, { prompt: initialMessage });
    },
    [navigate],
  );

  const handleOpenDocument = useCallback(
    (documentSurfaceId: string) => {
      void navigate(documentEntryUrl(documentSurfaceId, location.pathname), {
        state: documentEntryState(location, documentSurfaceId),
      });
    },
    [navigate, location],
  );

  // A new document opens the way any Library document does.
  const { newDocument, isCreating } = useNewLibraryDocument(
    assistantId,
    handleOpenDocument,
  );
  const supportsDocumentCreate = useSupportsDocumentCreate(assistantId);
  const handleNewDocument = useCallback(() => {
    void newDocument();
  }, [newDocument]);

  // Clicking an app navigates to /assistant/library/:appId, where
  // LibraryDetailPage handles the dedicated load/render/error UI.
  const handleOpenApp = useCallback(
    (appIdToOpen: string) => {
      void navigate(routes.library.app(appIdToOpen));
    },
    [navigate],
  );

  // Page shell, heading, and back chrome come from IntelligenceLayout —
  // this route mounts as one of its sections in routes.tsx.
  return (
    <LibraryView
      assistantId={assistantId}
      onNewConversation={handleNewConversation}
      onOpenDocument={handleOpenDocument}
      onNewDocument={supportsDocumentCreate ? handleNewDocument : undefined}
      isCreatingDocument={isCreating}
      onOpenApp={handleOpenApp}
    />
  );
}
