import { Button, Tag, Typography } from "@vellumai/design-library";
import { MessageSquareText, Send, X } from "lucide-react";
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
    createComment,
    deleteComment,
    fetchComments,
    reopenComment,
    resolveComment,
} from "@/domains/chat/api/document-comments";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import { DocumentCommentForm } from "./document-comment-form";
import { DocumentCommentThread } from "./document-comment-thread";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DocumentCommentPanelHandle {
  refreshComments: () => Promise<void>;
}

export interface DocumentCommentPanelProps {
  surfaceId: string;
  assistantId: string;
  conversationId: string;
  onClose: () => void;
  onCommentSelect?: (comment: DocumentsByIdCommentsPostResponse) => void;
  onSubmitFeedback?: () => void;
  /** Imperative handle for SSE-driven refresh triggers. */
  handleRef?: Ref<DocumentCommentPanelHandle>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Sidebar panel listing all document comments grouped by thread (top-level +
 * replies). Supports creating new document-level comments and performing
 * resolve / reopen / delete actions on existing ones.
 */
export function DocumentCommentPanel({
  surfaceId,
  assistantId,
  conversationId,
  onClose,
  onCommentSelect,
  onSubmitFeedback,
  handleRef,
}: DocumentCommentPanelProps) {
  const [comments, setComments] = useState<DocumentsByIdCommentsPostResponse[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const loadComments = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await fetchComments(assistantId, surfaceId);
        if (!signal?.aborted && mountedRef.current) {
          setComments(result);
        }
      } finally {
        if (!signal?.aborted && mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [assistantId, surfaceId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void loadComments(controller.signal);
    return () => {
      controller.abort();
      mountedRef.current = false;
    };
  }, [loadComments]);

  // Expose refreshComments for external callers (e.g. SSE handler).
  useImperativeHandle(handleRef, () => ({ refreshComments: loadComments }), [
    loadComments,
  ]);

  const topLevelComments = useMemo(
    () => comments.filter((c) => c.parentCommentId === null),
    [comments],
  );

  const repliesByParent = useMemo(() => {
    const map = new Map<string, DocumentsByIdCommentsPostResponse[]>();
    for (const c of comments) {
      if (c.parentCommentId !== null) {
        const existing = map.get(c.parentCommentId);
        if (existing) {
          existing.push(c);
        } else {
          map.set(c.parentCommentId, [c]);
        }
      }
    }
    return map;
  }, [comments]);

  const handleCreate = useCallback(
    async (content: string) => {
      await createComment(assistantId, surfaceId, {
        content,
        conversationId,
      });
      await loadComments();
    },
    [assistantId, surfaceId, conversationId, loadComments],
  );

  const handleResolve = useCallback(
    async (commentId: string) => {
      await resolveComment(assistantId, surfaceId, commentId);
      await loadComments();
    },
    [assistantId, surfaceId, loadComments],
  );

  const handleReopen = useCallback(
    async (commentId: string) => {
      await reopenComment(assistantId, surfaceId, commentId);
      await loadComments();
    },
    [assistantId, surfaceId, loadComments],
  );

  const handleDelete = useCallback(
    async (commentId: string) => {
      await deleteComment(assistantId, surfaceId, commentId);
      await loadComments();
    },
    [assistantId, surfaceId, loadComments],
  );

  const handleReply = useCallback(
    async (parentCommentId: string, content: string) => {
      await createComment(assistantId, surfaceId, {
        content,
        conversationId,
        parentCommentId,
      });
      await loadComments();
    },
    [assistantId, surfaceId, conversationId, loadComments],
  );

  const commentCount = topLevelComments.length;

  const hasOpenComments = useMemo(
    () => comments.some((c) => c.status === "open"),
    [comments],
  );

  return (
    <div className="flex h-full w-80 flex-col border-l border-[var(--border-base)] bg-[var(--surface-overlay)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-3">
        <MessageSquareText
          size={16}
          style={{ color: "var(--content-secondary)" }}
        />
        <Typography
          variant="title-small"
          className="flex-1 text-[var(--content-emphasised)]"
        >
          Comments
        </Typography>
        {!loading && commentCount > 0 ? (
          <Tag tone="neutral">{commentCount}</Tag>
        ) : null}
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          aria-label="Close comments panel"
          onClick={onClose}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Typography
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              Loading comments…
            </Typography>
          </div>
        ) : topLevelComments.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12">
            <MessageSquareText
              size={32}
              style={{ color: "var(--content-tertiary)" }}
            />
            <Typography
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              No comments yet
            </Typography>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {topLevelComments.map((comment) => (
              <DocumentCommentThread
                key={comment.id}
                comment={comment}
                replies={repliesByParent.get(comment.id) ?? []}
                onResolve={handleResolve}
                onReopen={handleReopen}
                onDelete={handleDelete}
                onReply={handleReply}
                onCommentSelect={onCommentSelect}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--border-base)] p-4">
        <DocumentCommentForm
          onSubmit={handleCreate}
          placeholder="Add a comment…"
        />
        {onSubmitFeedback && hasOpenComments ? (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<Send />}
            onClick={onSubmitFeedback}
            className="w-full"
          >
            Submit Feedback
          </Button>
        ) : null}
      </div>
    </div>
  );
}
