import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { FilePreviewContainer } from "@/domains/chat/components/local-file/preview/file-preview-container";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { OpenedDocumentState } from "@/stores/viewer-store";

interface MobileDocumentOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedDocumentState: OpenedDocumentState | null;
  /** Resolved assistant id forwarded to the document viewer. */
  assistantId: string | null;
  /** Closes the overlay (resets `openedDocumentState` upstream). */
  onClose: () => void;
  /** Called when the user clicks "Submit Feedback" in the comment panel. */
  onSubmitFeedback?: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the document viewer for a surface
 * referenced from chat, or the read-only preview for a workspace file the
 * editor cannot round-trip.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileDocumentOverlay({
  openedDocumentState,
  assistantId,
  onClose,
  onSubmitFeedback,
}: MobileDocumentOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!openedDocumentState || !assistantId) {
    return null;
  }

  if (openedDocumentState.source === "workspace-file-preview") {
    return (
      <div className="fixed inset-x-0 z-30" style={shellStyle}>
        <FilePreviewContainer
          key={`preview:${openedDocumentState.workspacePath}`}
          assistantId={assistantId}
          workspacePath={openedDocumentState.workspacePath}
          documentName={openedDocumentState.documentName}
          previewKind={openedDocumentState.previewKind}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      {/*
        Keyed per document so switching targets remounts the editor. Feeding a
        new document into the mounted editor emits a Tiptap update, which the
        autosave would write straight into whichever target is now current.
      */}
      <DocumentViewerContainer
        key={`document:${openedDocumentState.surfaceId}`}
        source="document"
        documentName={openedDocumentState.documentName}
        content={openedDocumentState.content}
        onClose={onClose}
        assistantId={assistantId}
        surfaceId={openedDocumentState.surfaceId}
        conversationId={openedDocumentState.conversationId}
        workspacePath={openedDocumentState.workspacePath}
        onSubmitFeedback={onSubmitFeedback}
      />
    </div>
  );
}
