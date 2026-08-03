/**
 * Document viewer with integrated comment panel.
 *
 * Renders the document content using a Tiptap/ProseMirror editor and provides
 * a toggleable comment sidebar. Comment anchors, active highlights, and text
 * selection are wired via React props/callbacks (no iframe postMessage).
 *
 * One backing store: a document surface in the daemon's document database.
 * A surface bound to a workspace markdown file passes that file's path so the
 * navbar can name it and the workspace browser's cache can be refreshed after
 * a save, but it saves and behaves exactly like any other document.
 */

import { useQueryClient } from "@tanstack/react-query";
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
import {
  saveDocumentContent,
  type DocumentSaveTarget,
} from "@/domains/chat/api/document-save";
import {
  localFileBlobQueryKey,
  localFileInfoQueryKey,
} from "@/domains/chat/components/local-file/use-local-file-info";
import type { CommentAnchor } from "@/domains/chat/utils/tiptap-position-map";
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
  /**
   * The workspace markdown file this document is bound to, when it has one.
   * The daemon writes saves through to it, so the client only needs the path
   * to name the file in the navbar and to invalidate the workspace browser's
   * view of it after a save.
   */
  workspacePath?: string | null;
  onExport?: () => void;
  onSubmitFeedback?: () => void;
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
  workspacePath = null,
  onExport,
  onSubmitFeedback,
}: DocumentViewerContainerProps) {
  // Where autosave writes.
  const saveTarget: DocumentSaveTarget = {
    source: "document",
    assistantId,
    surfaceId,
    conversationId,
    title: documentName,
  };

  const queryClient = useQueryClient();
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

  // The debounced save reads its destination through refs rather than the
  // closure the keystroke created. The container is keyed per document, so a
  // switch unmounts it with a save still pending, and a rename changes the
  // title under a mounted one; both are cases where the value captured when
  // the keystroke landed is no longer where the text belongs. The backing file
  // rides along for the same reason, and the pending markdown does so the
  // unmount flush below has something to write.
  const saveTargetRef = useRef(saveTarget);
  const workspacePathRef = useRef(workspacePath);
  const pendingMarkdownRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    saveTargetRef.current = saveTarget;
    workspacePathRef.current = workspacePath;
  });

  const flushPendingSave = useCallback(() => {
    const markdown = pendingMarkdownRef.current;
    if (markdown === null) {
      return;
    }
    pendingMarkdownRef.current = null;
    const target = saveTargetRef.current;
    const savedFile = workspacePathRef.current;
    void saveDocumentContent(target, markdown).then(
      () => {
        setSaveStatus("saved");
        savedFadeRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
        if (savedFile !== null) {
          // The daemon wrote this document through to its backing file, and
          // the workspace browser reads that file through its own query, so
          // that query must see the new bytes.
          void queryClient.invalidateQueries({
            queryKey: ["assistantsWorkspaceFileRetrieve"],
          });
          // The transcript's embeds and the drawer's read-only preview read
          // the same file through the local-file queries, which hold their
          // bytes indefinitely. Both are now a version behind.
          void queryClient.invalidateQueries({
            queryKey: localFileBlobQueryKey(savedFile, assistantId),
          });
          void queryClient.invalidateQueries({
            queryKey: localFileInfoQueryKey(savedFile, assistantId),
          });
        }
      },
      () => setSaveStatus("idle"),
    );
  }, [assistantId, queryClient]);

  const handleContentChange = useCallback(
    (markdown: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (savedFadeRef.current) {
        clearTimeout(savedFadeRef.current);
      }
      pendingMarkdownRef.current = markdown;
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
  }, [surfaceId, workspacePath]);

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
      {/* Navbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-2">
        <FileText size={16} style={{ color: "var(--content-secondary)" }} />
        <Typography
          variant="title-small"
          className="min-w-0 flex-1 truncate text-[var(--content-emphasised)]"
          // The full path tells the user which file on disk they are editing.
          title={workspacePath ?? undefined}
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
