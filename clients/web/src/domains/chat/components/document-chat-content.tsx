import { Button, Notice } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import type { RefObject } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useTranslation } from "@/i18n";
import {
  useViewerStore,
  type OpenedDocumentState,
} from "@/stores/viewer-store";

import { useDocumentCommentEvents } from "../hooks/use-document-comment-events";
import { useDocumentPdfExport } from "../hooks/use-document-pdf-export";
import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "./document-viewer-container";

interface DocumentChatContentProps {
  assistantId: string | null;
  surfaceId: string | null;
  document: OpenedDocumentState | null;
  loading: boolean;
  error: string | null;
  editorRef: RefObject<DocumentViewerContainerHandle | null>;
  onClose: () => void;
  onRetry: () => void;
  onSubmitFeedback: () => void;
}

/** Editor region inside the active chat's keyboard-aware app shell. */
export function DocumentChatContent({
  assistantId,
  surfaceId,
  document,
  loading,
  error,
  editorRef,
  onClose,
  onRetry,
  onSubmitFeedback,
}: DocumentChatContentProps) {
  const { t } = useTranslation("chat");
  const handleExport = useDocumentPdfExport(
    assistantId,
    surfaceId,
    document?.documentName,
  );
  const handleCommentEvent = useDocumentCommentEvents({
    surfaceId: surfaceId ?? "",
    enabled: !!surfaceId,
    onCommentsChanged: () => {
      void editorRef.current?.refreshComments();
    },
  });
  useBusSubscription("sse.event", handleCommentEvent);
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <Notice
        tone="error"
        actions={
          <>
            <Button onClick={onRetry}>{t("exportProgressModal.retry")}</Button>
            <Button variant="outlined" onClick={onClose}>
              {t("documentViewerContainer.closeDocumentAria")}
            </Button>
          </>
        }
      >
        {error}
      </Notice>
    );
  }
  if (
    !assistantId ||
    document?.source !== "document" ||
    document.surfaceId !== surfaceId
  ) {
    return null;
  }
  return (
    <DocumentViewerContainer
      key={`${assistantId}:${surfaceId}`}
      handleRef={editorRef}
      source="document"
      assistantId={assistantId}
      surfaceId={document.surfaceId}
      conversationId={document.conversationId}
      documentName={document.documentName}
      content={document.content}
      onClose={onClose}
      onRenamed={(name) =>
        useViewerStore.getState().renameOpenedDocument(document.surfaceId, name)
      }
      onSubmitFeedback={onSubmitFeedback}
      onExport={handleExport}
    />
  );
}
