import { DocumentComposerPanel } from "@/domains/chat/components/document-composer-panel";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { FilePreviewContainer } from "@/domains/chat/components/local-file/preview/file-preview-container";
import type { DocumentConversationRef } from "@/domains/chat/utils/document-conversation";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import {
  useViewerStore,
  type OpenedDocumentState,
} from "@/stores/viewer-store";

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
 * referenced from chat, or the read-only preview for a workspace file.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 *
 * A db-backed document gets a `DocumentComposerPanel` pinned below the editor
 * (wired to the composer store's `"document"` slot; shared with the
 * standalone document route's mobile composer). This component returns
 * `null` between documents, unmounting the panel along with it, so anything
 * that must survive the user closing the document before the assistant
 * answers (the "Assistant replied" toast watcher) lives elsewhere, in the
 * always-mounted `DocumentComposerReplyWatcher`.
 */
export function MobileDocumentOverlay({
  openedDocumentState,
  assistantId,
  onClose,
  onSubmitFeedback,
}: MobileDocumentOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  // Called before any early return (Rules of Hooks): narrowed to `null` for
  // the workspace-file-preview branch, which has no `conversationId` to send
  // a message against.
  const docRef: DocumentConversationRef | null =
    openedDocumentState?.source === "document"
      ? {
          surfaceId: openedDocumentState.surfaceId,
          conversationId: openedDocumentState.conversationId,
        }
      : null;

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
    <div className="fixed inset-x-0 z-30 flex flex-col" style={shellStyle}>
      {/*
        Keyed per document so switching targets remounts the editor. Feeding a
        new document into the mounted editor emits a Tiptap update, which the
        autosave would write straight into whichever target is now current.
      */}
      <div className="min-h-0 flex-1">
        <DocumentViewerContainer
          key={`document:${openedDocumentState.surfaceId}`}
          source="document"
          documentName={openedDocumentState.documentName}
          content={openedDocumentState.content}
          onClose={onClose}
          assistantId={assistantId}
          surfaceId={openedDocumentState.surfaceId}
          conversationId={openedDocumentState.conversationId}
          onRenamed={(documentName) =>
            useViewerStore
              .getState()
              .renameOpenedDocument(openedDocumentState.surfaceId, documentName)
          }
          onSubmitFeedback={onSubmitFeedback}
        />
      </div>
      <DocumentComposerPanel
        key={`document-composer:${openedDocumentState.surfaceId}`}
        assistantId={assistantId}
        doc={docRef}
      />
    </div>
  );
}
