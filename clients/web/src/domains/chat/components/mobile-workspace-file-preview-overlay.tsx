import { FilePreviewContainer } from "@/domains/chat/components/local-file/preview/file-preview-container";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { OpenedDocumentState } from "@/stores/viewer-store";

interface MobileWorkspaceFilePreviewOverlayProps {
  /** When `null`, the overlay renders nothing. */
  openedDocumentState: Extract<
    OpenedDocumentState,
    { source: "workspace-file-preview" }
  > | null;
  /** Resolved assistant id forwarded to the document viewer. */
  assistantId: string | null;
  /** Closes the overlay (resets `openedDocumentState` upstream). */
  onClose: () => void;
}

/**
 * Mobile-only full-screen read-only preview for a workspace file.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileWorkspaceFilePreviewOverlay({
  openedDocumentState,
  assistantId,
  onClose,
}: MobileWorkspaceFilePreviewOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!openedDocumentState || !assistantId) {
    return null;
  }

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
