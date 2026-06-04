/**
 * Document viewer with integrated comment panel.
 *
 * Renders the document content using a Tiptap/ProseMirror editor and provides
 * a toggleable comment sidebar. Comment anchors, active highlights, and text
 * selection are wired via React props/callbacks (no iframe postMessage).
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

import { LazyBoundary } from "@/components/lazy-boundary";
import { Button, Typography } from "@vellumai/design-library";
import {
    Check,
    Download,
    FileText,
    Loader2,
    MessageSquareText,
    X,
} from "lucide-react";

import {
    createComment,
    fetchComments,
} from "@/domains/chat/api/document-comments";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
import { documentsPost } from "@/generated/daemon/sdk.gen";
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
}

export interface DocumentViewerContainerProps {
  surfaceId: string;
  assistantId: string;
  conversationId: string;
  documentName: string;
  content: string;
  onClose: () => void;
  onExport?: () => void;
  onSubmitFeedback?: () => void;
  /** Imperative handle ref for SSE-driven refresh triggers. */
  handleRef?: Ref<DocumentViewerContainerHandle>;
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
  surfaceId,
  assistantId,
  conversationId,
  documentName,
  content,
  onClose,
  onExport,
  onSubmitFeedback,
  handleRef,
}: DocumentViewerContainerProps) {
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

  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const savedFadeRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(() => {
        const wordCount = markdown
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0).length;
        void documentsPost({
          path: { assistant_id: assistantId },
          body: {
            surfaceId,
            conversationId,
            title: documentName,
            content: markdown,
            wordCount,
          },
          throwOnError: true,
        }).then(
          () => {
            setSaveStatus("saved");
            savedFadeRef.current = setTimeout(
              () => setSaveStatus("idle"),
              2000,
            );
          },
          () => setSaveStatus("idle"),
        );
      }, 1000);
    },
    [assistantId, surfaceId, conversationId, documentName],
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
      if (!textSelection) return;
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
  // Sync anchors when panel opens
  // -------------------------------------------------------------------------

  // The panel also fetches comments on mount — this is a second request to
  // seed the anchor highlights. Acceptable tradeoff vs adding an
  // onCommentsLoaded callback to the panel component.
  useEffect(() => {
    if (!commentsPanelOpen) return;
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
      {/* Navbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2">
        <FileText size={16} style={{ color: "var(--content-secondary)" }} />
        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
        >
          {documentName}
        </Typography>

        {saveStatus !== "idle" ? (
          <span className="flex items-center gap-1 text-[var(--content-tertiary)]">
            {saveStatus === "saving" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Check size={12} />
            )}
            <Typography
              variant="label-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {saveStatus === "saving" ? "Saving…" : "Saved"}
            </Typography>
          </span>
        ) : null}

        {onExport ? (
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<Download />}
            onClick={onExport}
          >
            Export
          </Button>
        ) : null}

        <Button
          variant={commentsPanelOpen ? "outlined" : "ghost"}
          size="compact"
          leftIcon={<MessageSquareText />}
          onClick={toggleComments}
          aria-label={commentsPanelOpen ? "Close comments" : "Open comments"}
          aria-pressed={commentsPanelOpen}
        >
          Comments
        </Button>

        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close document"
          tooltip="Close"
        />
      </div>

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
