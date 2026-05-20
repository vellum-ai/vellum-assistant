import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container.js";
import type { OpenedDocumentState } from "@/stores/viewer-store.js";

interface MobileDocumentOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedDocumentState: OpenedDocumentState | null;
  /** Resolved assistant id forwarded to the document viewer. */
  assistantId: string | null;
  /** Closes the overlay (resets `openedDocumentState` upstream). */
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the document viewer for a
 * surface referenced from chat.
 *
 * **Mounting constraint**: must render outside `RootLayout`'s inner
 * transformed wrapper (see `src/components/layout/root-layout.tsx`) so
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
}: MobileDocumentOverlayProps) {
  if (!openedDocumentState) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]">
      <DocumentViewerContainer
        documentName={openedDocumentState.documentName}
        content={openedDocumentState.content}
        onClose={onClose}
        assistantId={assistantId ?? undefined}
        surfaceId={openedDocumentState.surfaceId}
      />
    </div>
  );
}
