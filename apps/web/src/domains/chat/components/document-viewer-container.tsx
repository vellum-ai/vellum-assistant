/**
 * Document viewer with integrated comment panel.
 *
 * Renders the document content in a sandboxed iframe and provides a
 * toggleable comment sidebar. Communication between the parent and the
 * iframe uses postMessage exclusively:
 *
 * Parent → Iframe:
 *   - `highlight_range { start, end }` — scroll to and highlight a range
 *   - `set_comment_anchors { anchors: CommentAnchor[] }` — render persistent
 *     highlights for all inline comment anchors
 *
 * Iframe → Parent:
 *   - `text_selected { start, end, text }` — user selected text in the editor
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
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
import type { CommentAnchor } from "@/domains/chat/utils/editor-bridge.js";
import { generateEditorHTML } from "@/domains/chat/utils/editor-bridge.js";
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

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);
  const initialContentRef = useRef(content);

  // Generate the iframe HTML once on mount
  const editorHTML = useMemo(
    () => generateEditorHTML(initialContentRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Push content updates to the iframe in-place (preserves scroll position)
  useEffect(() => {
    if (content === initialContentRef.current) return;
    initialContentRef.current = content;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "set_content", content },
      "*",
    );
  }, [content]);

  // -------------------------------------------------------------------------
  // postMessage listener for iframe → parent events
  // -------------------------------------------------------------------------

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object" || typeof data.type !== "string") {
        return;
      }

      if (data.type === "text_selected") {
        const { start, end, text, rect } = data as {
          start: unknown;
          end: unknown;
          text: unknown;
          rect: unknown;
        };
        if (
          typeof start === "number" &&
          typeof end === "number" &&
          typeof text === "string" &&
          text.trim().length > 0
        ) {
          const selRect = rect && typeof rect === "object" ? rect as SelectionRect : undefined;
          setTextSelection({ start, end, text, rect: selRect });
        }
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  // Clear text selection when the comment panel is closed
  useEffect(() => {
    if (!commentsPanelOpen) {
      setTextSelection(null);
      setAddingInlineComment(false);
    }
  }, [commentsPanelOpen]);

  // -------------------------------------------------------------------------
  // postMessage senders: parent → iframe
  // -------------------------------------------------------------------------

  const postToIframe = useCallback(
    (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage(message, "*");
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Comment panel interaction handlers
  // -------------------------------------------------------------------------

  const handleCommentSelect = useCallback(
    (comment: DocumentComment) => {
      if (
        comment.anchorStart != null &&
        comment.anchorEnd != null
      ) {
        postToIframe({
          type: "highlight_range",
          start: comment.anchorStart,
          end: comment.anchorEnd,
        });
      }
    },
    [postToIframe],
  );

  /** Send current inline comment anchors to the iframe for rendering. */
  const syncAnchorsToIframe = useCallback(
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
      postToIframe({ type: "set_comment_anchors", anchors });
    },
    [postToIframe],
  );

  /**
   * Refresh the comment panel and re-sync anchors to the iframe.
   * Called by SSE event handlers and after creating inline comments.
   */
  const refreshComments = useCallback(async () => {
    await commentPanelRef.current?.refreshComments();
    try {
      const comments = await fetchComments(assistantId, surfaceId);
      syncAnchorsToIframe(comments);
    } catch {
      // Best-effort — anchor highlights are cosmetic
    }
  }, [assistantId, surfaceId, syncAnchorsToIframe]);

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
  // Sync anchors to iframe when panel opens
  // -------------------------------------------------------------------------

  // The panel also fetches comments on mount — this is a second request to
  // seed the iframe anchor highlights. Acceptable tradeoff vs adding an
  // onCommentsLoaded callback to the panel component.
  useEffect(() => {
    if (!commentsPanelOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const comments = await fetchComments(assistantId, surfaceId);
        if (!cancelled) {
          syncAnchorsToIframe(comments);
        }
      } catch {
        // Best-effort — anchor highlights are cosmetic
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commentsPanelOpen, assistantId, surfaceId, syncAnchorsToIframe]);

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
        {/* Editor iframe */}
        <div className="relative min-w-0 flex-1">
          <iframe
            ref={iframeRef}
            srcDoc={editorHTML}
            sandbox="allow-scripts"
            title="Document editor"
            className="h-full w-full border-none"
            style={{ background: "transparent" }}
          />

          {/* Floating inline comment popover anchored to selection */}
          {commentsPanelOpen && textSelection ? (
            <div
              className="absolute z-10 w-72 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] shadow-lg"
              style={
                textSelection.rect && iframeRef.current
                  ? (() => {
                      const iframeRect = iframeRef.current.getBoundingClientRect();
                      const containerRect = iframeRef.current.parentElement!.getBoundingClientRect();
                      const top = textSelection.rect!.bottom + (iframeRect.top - containerRect.top) + 8;
                      const left = Math.max(8, Math.min(
                        textSelection.rect!.left + (iframeRect.left - containerRect.left),
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
