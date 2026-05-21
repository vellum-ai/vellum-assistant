/**
 * Document viewer with integrated comment panel.
 *
 * Renders the document content using a Tiptap/ProseMirror editor and provides
 * a toggleable comment sidebar. Comment anchors, active highlights, and text
 * selection are wired via React props/callbacks (no iframe postMessage).
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  ArrowLeft,
  Download,
  FileText,
  MessageSquareText,
  X,
} from "lucide-react";
import { Button, Typography } from "@vellum/design-library";

import type { DocumentComment } from "@/domains/chat/api/document-comments.js";
import { createComment, fetchComments } from "@/domains/chat/api/document-comments.js";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map.js";
import { TiptapDocumentEditor } from "./tiptap-document-editor.js";
import {
  DocumentCommentPanel,
  type DocumentCommentPanelHandle,
} from "./document-comment-panel.js";

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
  const [activeHighlight, setActiveHighlight] = useState<{ start: number; end: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);

  // Clear text selection when the comment panel is closed
  useEffect(() => {
    if (!commentsPanelOpen) {
      setTextSelection(null);
      setAddingInlineComment(false);
    }
  }, [commentsPanelOpen]);

  // -------------------------------------------------------------------------
  // Comment panel interaction handlers
  // -------------------------------------------------------------------------

  const handleCommentSelect = useCallback(
    (comment: DocumentComment) => {
      if (
        comment.anchorStart != null &&
        comment.anchorEnd != null
      ) {
        setActiveHighlight({ start: comment.anchorStart, end: comment.anchorEnd });
      }
    },
    [],
  );

  /** Derive comment anchors from loaded comments and push to state. */
  const updateCommentAnchors = useCallback(
    (comments: DocumentComment[]) => {
      const anchors: CommentAnchor[] = comments
        .filter(
          (c): c is DocumentComment & { anchorStart: number; anchorEnd: number } =>
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
  useImperativeHandle(handleRef, () => ({ refreshComments }), [refreshComments]);

  // -------------------------------------------------------------------------
  // Inline comment creation
  // -------------------------------------------------------------------------

  const [inlineCommentDraft, setInlineCommentDraft] = useState("");

  const handleSubmitInlineComment = useCallback(async () => {
    if (!textSelection || !inlineCommentDraft.trim()) return;
    setAddingInlineComment(true);
    try {
      await createComment(assistantId, surfaceId, {
        content: inlineCommentDraft.trim(),
        conversationId,
        anchorStart: textSelection.start,
        anchorEnd: textSelection.end,
        anchorText: textSelection.text,
      });
      setInlineCommentDraft("");
      setTextSelection(null);
      await refreshComments();
    } finally {
      setAddingInlineComment(false);
    }
  }, [
    assistantId,
    surfaceId,
    conversationId,
    textSelection,
    inlineCommentDraft,
    refreshComments,
  ]);

  const handleDismissInlinePopover = useCallback(() => {
    setTextSelection(null);
    setInlineCommentDraft("");
  }, []);

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
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<ArrowLeft />}
          aria-label="Close document"
          onClick={onClose}
        />
        <FileText
          size={16}
          style={{ color: "var(--content-secondary)" }}
        />
        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
        >
          {documentName}
        </Typography>

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
          aria-label={
            commentsPanelOpen ? "Close comments" : "Open comments"
          }
          aria-pressed={commentsPanelOpen}
        >
          Comments
        </Button>
      </div>

      {/* Body: editor + optional comment panel */}
      <div className="relative flex min-h-0 flex-1">
        {/* Tiptap editor */}
        <div ref={containerRef} className="relative min-w-0 flex-1">
          <TiptapDocumentEditor
            content={content}
            onTextSelect={(sel) => setTextSelection({
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
            })}
            commentAnchors={commentAnchors}
            highlightRange={activeHighlight}
            className="h-full"
          />

          {/* Floating inline comment popover anchored to selection */}
          {commentsPanelOpen && textSelection ? (
            <div
              className="absolute z-10 w-72 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] shadow-lg"
              style={
                textSelection.rect && containerRef.current
                  ? (() => {
                      const containerRect = containerRef.current.getBoundingClientRect();
                      const top = textSelection.rect!.bottom - containerRect.top + 8;
                      const left = Math.max(8, Math.min(
                        textSelection.rect!.left - containerRect.left,
                        containerRect.width - 288 - 8,
                      ));
                      return { top, left };
                    })()
                  : { right: 16, bottom: 16 }
              }
            >
              <div className="flex items-start gap-2 border-b border-[var(--border-base)] px-3 py-2">
                <Typography
                  variant="label-small-default"
                  className="min-w-0 flex-1 truncate text-[var(--content-tertiary)]"
                >
                  &ldquo;{textSelection.text.length > 60
                    ? textSelection.text.slice(0, 60) + "…"
                    : textSelection.text}&rdquo;
                </Typography>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={<X className="h-3 w-3" />}
                  aria-label="Dismiss"
                  onClick={handleDismissInlinePopover}
                />
              </div>
              <div className="p-3">
                <textarea
                  className="w-full resize-none rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-2 py-1.5 text-sm text-[var(--content-emphasised)] placeholder:text-[var(--content-tertiary)] focus:border-[var(--border-focus)] focus:outline-none"
                  rows={2}
                  placeholder="Add your feedback…"
                  value={inlineCommentDraft}
                  onChange={(e) => setInlineCommentDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSubmitInlineComment();
                    }
                  }}
                  autoFocus
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="primary"
                    size="compact"
                    onClick={() => void handleSubmitInlineComment()}
                    disabled={addingInlineComment || !inlineCommentDraft.trim()}
                  >
                    {addingInlineComment ? "Adding…" : "Comment"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
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
