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
 * **Mounting constraint**: must render outside `RootLayout`'s inner
 * transformed wrapper (see `src/root-layout.tsx`) so
 * `position: fixed` anchors to the viewport's initial containing block
 * rather than the keyboard-following transform `RootLayout` applies when
 * the soft keyboard opens.
 *
 * https://www.w3.org/TR/css-transforms-1/#transform-rendering
 */
export function MobileDocumentOverlay({
  openedDocumentState,
  assistantId,
  onClose,
  onSubmitFeedback,
}: MobileDocumentOverlayProps) {
  if (!openedDocumentState || !assistantId) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]">
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
