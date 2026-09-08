import { Check } from "lucide-react";
import { useRef } from "react";

import { Typography } from "@vellumai/design-library";

import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { DocumentViewerContainer } from "@/domains/chat/components/document-viewer-container";
import { FilePreviewContainer } from "@/domains/chat/components/local-file/preview/file-preview-container";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useDocumentComposerSubmit } from "@/domains/chat/hooks/use-document-composer-submit";
import type { DocumentConversationRef } from "@/domains/chat/utils/document-conversation";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { useTranslation } from "@/i18n";
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
 * A db-backed document gets a `ChatComposer` pinned below the editor, wired
 * to `useDocumentComposerSubmit` and the composer store's `"document"` slot —
 * see LUM-3384. This component stays mounted for the whole chat session (its
 * parent, `MobileChatOverlays`, renders it unconditionally and it just
 * returns `null` between documents), so the submit hook's reply-toast watcher
 * survives the user closing the document before the assistant answers.
 */
export function MobileDocumentOverlay({
  openedDocumentState,
  assistantId,
  onClose,
  onSubmitFeedback,
}: MobileDocumentOverlayProps) {
  const { t } = useTranslation("chat");
  const shellStyle = useMobileOverlayViewportStyle();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Called before any early return (Rules of Hooks) — narrowed to `null` for
  // the workspace-file-preview branch, which has no `conversationId` to send
  // a message against.
  const docRef: DocumentConversationRef | null =
    openedDocumentState?.source === "document"
      ? {
          surfaceId: openedDocumentState.surfaceId,
          conversationId: openedDocumentState.conversationId,
        }
      : null;
  const { status, submit } = useDocumentComposerSubmit({
    assistantId,
    doc: docRef,
  });

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

  const sending = status === "sending";

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
      <div
        className="shrink-0 px-3 pt-2"
        style={{ paddingBottom: "var(--overlay-safe-area-bottom)" }}
      >
        {status === "sent" && (
          <div className="flex items-center justify-center gap-1 pb-1 text-[var(--content-tertiary)]">
            <Check size={12} className="shrink-0" />
            <Typography
              variant="label-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {t("documentComposer.sent")}
            </Typography>
          </div>
        )}
        <ChatComposer
          slot="document"
          assistantId={assistantId}
          inputRef={inputRef}
          typingDisabled={sending}
          sendDisabled={sending}
          isAssistantBusy={false}
          onStopGenerating={() => {}}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onAddAttachmentFiles={(files) => {
            useComposerStore
              .getState()
              .addFiles(files, assistantId, "document");
          }}
        />
      </div>
    </div>
  );
}
