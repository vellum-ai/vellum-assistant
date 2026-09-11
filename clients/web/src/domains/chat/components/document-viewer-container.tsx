
import { useTranslation } from "@/i18n";
/**
 * Document viewer with integrated comment panel.
 *
 * Renders the document content using a Tiptap/ProseMirror editor and provides
 * a toggleable comment sidebar. Comment anchors, active highlights, and text
 * selection are wired via React props/callbacks (no iframe postMessage).
 *
 * One backing store: a document surface in the daemon's document database.
 * Both the autosave and the rename write through it, so the title the header
 * shows and the body the editor holds are always sent together.
 */

import {
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

import { useQueryClient } from "@tanstack/react-query";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ActionMenu, Button, toast, Typography } from "@vellumai/design-library";
import {
  Check,
  Download,
  Ellipsis,
  FileText,
  Loader2,
  MessageSquareText,
  PencilLine,
  X,
} from "lucide-react";

import {
  createComment,
  fetchComments,
} from "@/domains/chat/api/document-comments";
import {
  markdownWordCount,
  type DocumentSaveTarget,
} from "@/domains/chat/api/document-save";
import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";
import {
  useDocumentEditorSave,
  type DocumentEditorSnapshot,
  type DocumentSendPreparation,
} from "@/domains/chat/hooks/use-document-editor-save";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import { documentsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import {
  DocumentCommentPanel,
  type DocumentCommentPanelHandle,
} from "./document-comment-panel";

// Tiptap + ProseMirror pull in ~600 kB of editor code that's only needed
// when a document is opened. Splitting it out keeps the main bundle lean.
const TiptapDocumentEditor = lazy(() =>
  import("./tiptap-document-editor").then((m) => ({
    default: m.TiptapDocumentEditor,
  })),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DocumentViewerContainerHandle {
  /** Refresh the comment panel. Call when an SSE comment event arrives. */
  refreshComments: () => Promise<void>;
  flushPendingSave: () => Promise<DocumentEditorSnapshot>;
  beginSendPreparation: () => DocumentSendPreparation;
}

/** A document surface: autosave writes through the documents API. */
export interface DocumentViewerContainerProps {
  source: "document";
  assistantId: string;
  documentName: string;
  content: string;
  onClose: () => void;
  /** Imperative handle ref for SSE-driven refresh triggers. */
  handleRef?: Ref<DocumentViewerContainerHandle>;
  surfaceId: string;
  conversationId: string;
  onExport?: () => void;
  onSubmitFeedback?: () => void;
  /**
   * The document was retitled to `documentName`. The write has already been
   * sent; this is how the caller holding the name (the viewer store for the
   * chat drawer, page state for the standalone route) adopts it. Called a
   * second time with the previous name when that write fails, so an
   * optimistic rename rolls back the way a conversation rename does.
   */
  onRenamed?: (documentName: string) => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

interface TextSelection {
  start: number;
  end: number;
  text: string;
  rect?: SelectionRect;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentViewerContainer(props: DocumentViewerContainerProps) {
  return (
    <DocumentViewerContent
      key={`${props.assistantId}:${props.surfaceId}`}
      {...props}
    />
  );
}

function DocumentViewerContent({
  assistantId,
  documentName,
  content,
  onClose,
  handleRef,
  surfaceId,
  conversationId,
  onExport,
  onSubmitFeedback,
  onRenamed,
}: DocumentViewerContainerProps) {
  const { t } = useTranslation("chat");
  const queryClient = useQueryClient();
  // Where autosave writes.
  const saveTarget: DocumentSaveTarget = {
    source: "document",
    assistantId,
    surfaceId,
    conversationId,
    title: documentName,
  };

  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [textSelection, setTextSelection] = useState<TextSelection | null>(
    null,
  );
  const [addingInlineComment, setAddingInlineComment] = useState(false);
  const [commentAnchors, setCommentAnchors] = useState<CommentAnchor[]>([]);
  const [activeHighlight, setActiveHighlight] = useState<{
    start: number;
    end: number;
  } | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  // What the header's status line says when nothing is being saved. Derived
  // from the editor's live markdown rather than the documents list, so it
  // counts what is on screen while it is being typed.
  const [wordCount, setWordCount] = useState(() => markdownWordCount(content));

  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);
  const {
    saveStatus,
    editingLocked,
    editorContent,
    title,
    changeContent,
    rename,
    flushPendingSave,
    beginSendPreparation,
  } = useDocumentEditorSave({
    target: saveTarget,
    content,
    onRenamed,
    onRenameSaved: (savedTarget) => {
      void queryClient.invalidateQueries({
        queryKey: documentsGetQueryKey({
          path: { assistant_id: savedTarget.assistantId },
          query: { conversationId: savedTarget.conversationId },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: documentsGetQueryKey({
          path: { assistant_id: savedTarget.assistantId },
        }),
      });
    },
    onRenameFailed: () => toast.error(t("documentViewerContainer.renameFailed")),
  });

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (changeContent(markdown)) {
        setWordCount(markdownWordCount(markdown));
      }
    },
    [changeContent],
  );

  useEffect(() => {
    setWordCount(markdownWordCount(editorContent));
  }, [editorContent]);

  // Clear inline comment state when panel closes (but keep text selection
  // visible since the popover now works independently of the panel)
  useEffect(() => {
    if (!commentsPanelOpen) {
      setAddingInlineComment(false);
    }
  }, [commentsPanelOpen]);

  // Clear stale highlights when switching documents
  useEffect(() => {
    setCommentAnchors([]);
    setActiveHighlight(null);
    setTextSelection(null);
  }, [surfaceId]);

  // -------------------------------------------------------------------------
  // Comment panel interaction handlers
  // -------------------------------------------------------------------------

  const handleCommentSelect = useCallback(
    (comment: DocumentsByIdCommentsPostResponse) => {
      if (comment.anchorStart != null && comment.anchorEnd != null) {
        setActiveHighlight({
          start: comment.anchorStart,
          end: comment.anchorEnd,
        });
      }
    },
    [],
  );

  /** Derive comment anchors from loaded comments and push to state. */
  const updateCommentAnchors = useCallback(
    (comments: DocumentsByIdCommentsPostResponse[]) => {
      const anchors: CommentAnchor[] = comments
        .filter(
          (
            c,
          ): c is DocumentsByIdCommentsPostResponse & {
            anchorStart: number;
            anchorEnd: number;
          } =>
            c.status === "open" && c.anchorStart != null && c.anchorEnd != null,
        )
        .map((c) => ({
          commentId: c.id,
          anchorStart: c.anchorStart,
          anchorEnd: c.anchorEnd,
        }));
      setCommentAnchors(anchors);
    },
    [],
  );

  /**
   * Refresh the comment panel and re-sync anchor highlights.
   * Called by SSE event handlers and after creating inline comments.
   */
  const refreshComments = useCallback(async () => {
    await commentPanelRef.current?.refreshComments();
    try {
      const comments = await fetchComments(assistantId, surfaceId);
      updateCommentAnchors(comments);
    } catch {
      // Best-effort — anchor highlights are cosmetic
    }
  }, [assistantId, surfaceId, updateCommentAnchors]);

  useImperativeHandle(
    handleRef,
    () => ({ refreshComments, flushPendingSave, beginSendPreparation }),
    [refreshComments, flushPendingSave, beginSendPreparation],
  );

  // -------------------------------------------------------------------------
  // Inline comment creation
  // -------------------------------------------------------------------------

  const handleCommentSubmit = useCallback(
    async (commentText: string) => {
      if (!textSelection) {
        return;
      }
      setAddingInlineComment(true);
      try {
        await createComment(assistantId, surfaceId, {
          content: commentText,
          conversationId,
          anchorStart: textSelection.start,
          anchorEnd: textSelection.end,
          anchorText: textSelection.text,
        });
        setTextSelection(null);
        setCommentsPanelOpen(true);
        await refreshComments();
      } finally {
        setAddingInlineComment(false);
      }
    },
    [assistantId, surfaceId, conversationId, textSelection, refreshComments],
  );

  // -------------------------------------------------------------------------
  // Toggle handler
  // -------------------------------------------------------------------------

  const toggleComments = useCallback(() => {
    setCommentsPanelOpen((prev) => !prev);
  }, []);

  // -------------------------------------------------------------------------
  // Rename
  // -------------------------------------------------------------------------

  const handleRenameSubmit = useCallback(
    (nextTitle: string) => {
      setRenameOpen(false);
      rename(nextTitle);
    },
    [rename],
  );

  // -------------------------------------------------------------------------
  // Sync anchors when panel opens
  // -------------------------------------------------------------------------

  // The panel also fetches comments on mount — this is a second request to
  // seed the anchor highlights. Acceptable tradeoff vs adding an
  // onCommentsLoaded callback to the panel component.
  useEffect(() => {
    if (!commentsPanelOpen) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const comments = await fetchComments(assistantId, surfaceId);
        if (!cancelled) {
          updateCommentAnchors(comments);
        }
      } catch {
        // Best-effort — anchor highlights are cosmetic
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commentsPanelOpen, assistantId, surfaceId, updateCommentAnchors]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      {/*
        Header. The document's identity sits in a two-line block (name over a
        status line) so the panel opens with a heading rather than a strip of
        controls. Everything the document can do rides in one design-library
        overflow menu beside it, which leaves the header two affordances: the
        menu and the way out. Comments are in there as well, because the panel
        they open is its own answer about whether it is showing.
      */}
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3">
        <FileText
          size={16}
          className="mt-1 shrink-0"
          style={{ color: "var(--content-secondary)" }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* `title-small` sets `line-height: 1`, which `truncate` then crops
              descenders against. Give the line the room the font needs. */}
          <Typography
            variant="title-small"
            className="truncate leading-normal text-[var(--content-emphasised)]"
          >
            {title}
          </Typography>
          <span className="flex items-center gap-1 text-[var(--content-tertiary)]">
            {saveStatus === "saving" ? (
              <Loader2 size={12} className="shrink-0 animate-spin" />
            ) : null}
            {saveStatus === "saved" ? <Check size={12} className="shrink-0" /> : null}
            <Typography
              variant="label-small-default"
              className="truncate text-[var(--content-tertiary)]"
            >
              {saveStatus === "saving"
                ? t("documentViewerContainer.saving")
                : saveStatus === "saved"
                  ? t("documentViewerContainer.saved")
                  : t("documentViewerContainer.wordCount", {
                      count: wordCount,
                    })}
            </Typography>
          </span>
        </div>

        <ActionMenu.Root>
          <ActionMenu.Trigger>
            <Button
              variant="ghost"
              iconOnly={<Ellipsis />}
              disabled={editingLocked}
              aria-label={t("documentViewerContainer.menuAria")}
              tooltip={t("documentViewerContainer.menuAria")}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content
            title={t("documentViewerContainer.menuAria")}
            align="end"
          >
            <ActionMenu.Item
              icon={MessageSquareText}
              label={commentsPanelOpen ? t("documentViewerContainer.hideComments") : t("documentViewerContainer.comments")}
              onSelect={toggleComments}
            />
            <ActionMenu.Item
              icon={PencilLine}
              label={t("documentViewerContainer.rename")}
              onSelect={() => setRenameOpen(true)}
            />
            {onExport ? (
              <ActionMenu.Item
                icon={Download}
                label={t("documentViewerContainer.export")}
                onSelect={onExport}
              />
            ) : null}
          </ActionMenu.Content>
        </ActionMenu.Root>

        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label={t("documentViewerContainer.closeDocumentAria")}
          tooltip={t("documentViewerContainer.close")}
        />
      </header>

      <NameInputDialog
        open={renameOpen}
        title={t("documentViewerContainer.renameTitle")}
        submitLabel={t("documentViewerContainer.renameSave")}
        initialValue={title}
        onSubmit={handleRenameSubmit}
        onCancel={() => setRenameOpen(false)}
      />

      {/* Body: editor + optional comment panel */}
      <div className="relative flex min-h-0 flex-1">
        {/* Tiptap editor */}
        <div className="relative min-w-0 flex-1">
          <LazyBoundary
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-fg-tertiary" />
              </div>
            }
          >
            <TiptapDocumentEditor
              content={editorContent}
              editable={!editingLocked}
              onContentChange={handleContentChange}
              onTextSelect={(sel) => {
                if (!sel) {
                  setTextSelection(null);
                  return;
                }
                setTextSelection({
                  start: sel.start,
                  end: sel.end,
                  text: sel.text,
                  rect: {
                    top: sel.rect.top,
                    left: sel.rect.left,
                    bottom: sel.rect.bottom,
                    right: sel.rect.right,
                    width: sel.rect.width,
                    height: sel.rect.height,
                  },
                });
              }}
              commentAnchors={commentAnchors}
              highlightRange={activeHighlight}
              onCommentSubmit={(text) => void handleCommentSubmit(text)}
              commentSubmitting={addingInlineComment}
              className="h-full"
            />
          </LazyBoundary>
        </div>

        {/* Comment panel sidebar */}
        {commentsPanelOpen ? (
          <DocumentCommentPanel
            surfaceId={surfaceId}
            assistantId={assistantId}
            conversationId={conversationId}
            onClose={() => setCommentsPanelOpen(false)}
            onCommentSelect={handleCommentSelect}
            onSubmitFeedback={onSubmitFeedback}
            handleRef={commentPanelRef}
          />
        ) : null}
      </div>
    </div>
  );
}
