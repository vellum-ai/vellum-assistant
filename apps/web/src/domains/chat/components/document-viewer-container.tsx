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
  Plus,
} from "lucide-react";
import { Button, Typography } from "@vellum/design-library";

import type { DocumentComment } from "../lib/document-comments.js";
import { createComment, fetchComments } from "../lib/document-comments.js";
import type { CommentAnchor } from "../lib/editor-bridge.js";
import { generateEditorHTML } from "../lib/editor-bridge.js";
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
  /** Imperative handle ref for SSE-driven refresh triggers. */
  handleRef?: Ref<DocumentViewerContainerHandle>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TextSelection {
  start: number;
  end: number;
  text: string;
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
  handleRef,
}: DocumentViewerContainerProps) {
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [textSelection, setTextSelection] = useState<TextSelection | null>(
    null,
  );
  const [addingInlineComment, setAddingInlineComment] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const commentPanelRef = useRef<DocumentCommentPanelHandle>(null);

  // Generate the iframe HTML once per content change
  const editorHTML = useMemo(() => generateEditorHTML(content), [content]);

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
        const { start, end, text } = data as {
          start: unknown;
          end: unknown;
          text: unknown;
        };
        if (
          typeof start === "number" &&
          typeof end === "number" &&
          typeof text === "string" &&
          text.trim().length > 0
        ) {
          setTextSelection({ start, end, text });
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
            c.anchorStart != null && c.anchorEnd != null,
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
  }, []);

  // Expose refreshComments for external callers (e.g. SSE handler in page).
  useImperativeHandle(handleRef, () => ({ refreshComments }), [refreshComments]);

  // -------------------------------------------------------------------------
  // Inline comment creation
  // -------------------------------------------------------------------------

  const handleAddInlineComment = useCallback(async () => {
    if (!textSelection) return;
    setAddingInlineComment(true);
    try {
      await createComment(assistantId, surfaceId, {
        content: `Comment on: "${textSelection.text}"`,
        conversationId,
        anchorStart: textSelection.start,
        anchorEnd: textSelection.end,
        anchorText: textSelection.text,
      });
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
    refreshComments,
  ]);

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
          variant={commentsPanelOpen ? "secondary" : "ghost"}
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

          {/* Floating "Add Comment" button near selection */}
          {commentsPanelOpen && textSelection ? (
            <div className="absolute right-4 bottom-4 z-10">
              <Button
                variant="primary"
                size="compact"
                leftIcon={<Plus />}
                onClick={handleAddInlineComment}
                disabled={addingInlineComment}
              >
                {addingInlineComment
                  ? "Adding..."
                  : "Add Inline Comment"}
              </Button>
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
            handleRef={commentPanelRef}
          />
        ) : null}
      </div>
    </div>
  );
}
