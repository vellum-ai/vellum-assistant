
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
  useLayoutEffect,
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
  saveDocumentContent,
  type DocumentSaveTarget,
} from "@/domains/chat/api/document-save";
import { NameInputDialog } from "@/domains/chat/components/name-input-dialog";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import { documentsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
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

export function DocumentViewerContainer({
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

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [renameOpen, setRenameOpen] = useState(false);
  // What the header's status line says when nothing is being saved. Derived
  // from the editor's live markdown rather than the documents list, so it
  // counts what is on screen while it is being typed.
  const [wordCount, setWordCount] = useState(() => markdownWordCount(content));

  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const savedFadeRef = useRef<ReturnType<typeof setTimeout>>(null);

  // The debounced save reads its destination through refs rather than the
  // closure the keystroke created. The container is keyed per document, so a
  // switch unmounts it with a save still pending, and a rename changes the
  // title under a mounted one; both are cases where the value captured when
  // the keystroke landed is no longer where the text belongs. The pending
  // markdown rides along so the unmount flush below has something to write.
  const saveTargetRef = useRef(saveTarget);
  const pendingMarkdownRef = useRef<string | null>(null);
  // The last markdown the editor produced, kept past the save that wrote it.
  // A rename posts the body along with the title, and the `content` prop is
  // the snapshot the document loaded with: it does not follow the user's
  // typing, so posting it would undo every edit already saved.
  const latestMarkdownRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    saveTargetRef.current = saveTarget;
  });

  const flushPendingSave = useCallback(() => {
    const markdown = pendingMarkdownRef.current;
    if (markdown === null) {
      return;
    }
    pendingMarkdownRef.current = null;
    const target = saveTargetRef.current;
    void saveDocumentContent(target, markdown).then(
      () => {
        setSaveStatus("saved");
        savedFadeRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      },
      () => setSaveStatus("idle"),
    );
  }, []);

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (savedFadeRef.current) {
        clearTimeout(savedFadeRef.current);
      }
      pendingMarkdownRef.current = markdown;
      latestMarkdownRef.current = markdown;
      setWordCount(markdownWordCount(markdown));
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        flushPendingSave();
      }, 1000);
    },
    [flushPendingSave],
  );

  // A keyed remount takes the pending timer down with it, so an edit made in
  // the last second before a document switch or a close would never reach the
  // daemon. Fire it now instead: the refs still name the document being left,
  // so the text lands where it was typed.
  const flushPendingSaveRef = useRef(flushPendingSave);
  useLayoutEffect(() => {
    flushPendingSaveRef.current = flushPendingSave;
  });
  useEffect(
    () => () => {
      if (savedFadeRef.current) {
        clearTimeout(savedFadeRef.current);
        savedFadeRef.current = null;
      }
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        flushPendingSaveRef.current();
      }
    },
    [],
  );

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

  // Expose refreshComments for external callers (e.g. SSE handler in page).
  useImperativeHandle(handleRef, () => ({ refreshComments }), [
    refreshComments,
  ]);

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

  /**
   * Retitle the document. The documents API is an upsert keyed by surface, so
   * the rename is the same write autosave makes, with a different title on it:
   * there is no title-only endpoint to reach for.
   *
   * Optimistic, the way the conversation rename is: the caller adopts the new
   * name immediately and takes the old one back if the write fails.
   */
  const handleRenameSubmit = useCallback(
    (nextTitle: string) => {
      setRenameOpen(false);
      const title = nextTitle.trim();
      const previousTitle = documentName;
      if (title === "" || title === previousTitle) {
        return;
      }

      // A debounced edit is still owed a write, and it would carry the old
      // title. Fold it into the rename rather than racing it: this write
      // sends the same markdown.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (savedFadeRef.current) {
        clearTimeout(savedFadeRef.current);
      }
      pendingMarkdownRef.current = null;

      onRenamed?.(title);
      setSaveStatus("saving");
      void saveDocumentContent(
        { ...saveTargetRef.current, title },
        latestMarkdownRef.current ?? content,
      ).then(
        () => {
          setSaveStatus("saved");
          savedFadeRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
          // The name is read from the documents list by the transcript card,
          // the assets pill, and the Library. The conversation-scoped list and
          // the assistant-wide one are separate cache entries; both carry it.
          void queryClient.invalidateQueries({
            queryKey: documentsGetQueryKey({
              path: { assistant_id: assistantId },
              query: { conversationId },
            }),
          });
          void queryClient.invalidateQueries({
            queryKey: documentsGetQueryKey({
              path: { assistant_id: assistantId },
            }),
          });
        },
        (err: unknown) => {
          setSaveStatus("idle");
          onRenamed?.(previousTitle);
          toast.error(t("documentViewerContainer.renameFailed"));
          captureError(err, { context: "renameDocument" });
        },
      );
    },
    [
      assistantId,
      content,
      conversationId,
      documentName,
      onRenamed,
      queryClient,
      t,
    ],
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
            {documentName}
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
        initialValue={documentName}
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
              content={content}
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
