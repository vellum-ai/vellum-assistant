import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
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
 * Mobile-only full-screen overlay that hosts the document viewer for a
 * surface referenced from chat.
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
  if (!openedDocumentState || !assistantId) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft: "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight: "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
      }}
    >
      <DocumentViewerContainer
        documentName={openedDocumentState.documentName}
        content={openedDocumentState.content}
        onClose={onClose}
        assistantId={assistantId}
        surfaceId={openedDocumentState.surfaceId}
        conversationId={openedDocumentState.conversationId}
        onSubmitFeedback={onSubmitFeedback}
      />
    </div>
  );
}
