/**
 * SSE event handlers for document comment lifecycle events.
 *
 * Each handler is a pure function that accepts a typed event payload and a
 * callback for signalling state changes. PR 10 (viewer integration) will
 * wire these into the main SSE stream processor.
 */

import type {
  DocumentCommentCreatedEvent,
  DocumentCommentDeletedEvent,
  DocumentCommentReopenedEvent,
  DocumentCommentResolvedEvent,
} from "@vellumai/assistant-api";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";

export type DocumentCommentEvent =
  | DocumentCommentCreatedEvent
  | DocumentCommentResolvedEvent
  | DocumentCommentReopenedEvent
  | DocumentCommentDeletedEvent;

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface DocumentCommentEventCallbacks {
  /** Notify the comment panel that the comment list for a surface changed. */
  onCommentsChanged: (surfaceId: string) => void;
}

// ---------------------------------------------------------------------------
// State container
// ---------------------------------------------------------------------------

/**
 * Mutable map of surfaceId -> comments. Handlers mutate this structure
 * in-place so the caller can maintain a single shared reference.
 */
export type CommentStateMap = Map<string, DocumentsByIdCommentsPostResponse[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDocumentComment(
  event: DocumentCommentCreatedEvent,
): DocumentsByIdCommentsPostResponse {
  const c = event.comment;
  return {
    id: c.id,
    surfaceId: c.surfaceId,
    conversationId: event.conversationId,
    author: c.author === "assistant" ? "assistant" : "user",
    content: c.content,
    anchorStart: c.anchorStart ?? null,
    anchorEnd: c.anchorEnd ?? null,
    anchorText: c.anchorText ?? null,
    parentCommentId: c.parentCommentId ?? null,
    status: c.status === "resolved" ? "resolved" : "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** Add a newly created comment to local state. */
export function handleDocumentCommentCreated(
  event: DocumentCommentCreatedEvent,
  state: CommentStateMap,
  callbacks: DocumentCommentEventCallbacks,
): void {
  const comment = toDocumentComment(event);
  const existing = state.get(event.surfaceId) ?? [];
  if (existing.some((c) => c.id === comment.id)) return;
  existing.push(comment);
  state.set(event.surfaceId, existing);
  callbacks.onCommentsChanged(event.surfaceId);
}

/** Mark a comment as resolved in local state. */
export function handleDocumentCommentResolved(
  event: DocumentCommentResolvedEvent,
  state: CommentStateMap,
  callbacks: DocumentCommentEventCallbacks,
): void {
  const comments = state.get(event.surfaceId);
  if (!comments) return;

  const target = comments.find((c) => c.id === event.commentId);
  if (!target) return;

  target.status = "resolved";
  target.resolvedBy = event.resolvedBy;
  target.resolvedAt = Date.now();
  callbacks.onCommentsChanged(event.surfaceId);
}

/** Mark a comment as open (re-opened) in local state. */
export function handleDocumentCommentReopened(
  event: DocumentCommentReopenedEvent,
  state: CommentStateMap,
  callbacks: DocumentCommentEventCallbacks,
): void {
  const comments = state.get(event.surfaceId);
  if (!comments) return;

  const target = comments.find((c) => c.id === event.commentId);
  if (!target) return;

  target.status = "open";
  target.resolvedBy = null;
  target.resolvedAt = null;
  callbacks.onCommentsChanged(event.surfaceId);
}

/** Remove a comment from local state. */
export function handleDocumentCommentDeleted(
  event: DocumentCommentDeletedEvent,
  state: CommentStateMap,
  callbacks: DocumentCommentEventCallbacks,
): void {
  const comments = state.get(event.surfaceId);
  if (!comments) return;

  const idx = comments.findIndex((c) => c.id === event.commentId);
  if (idx === -1) return;

  comments.splice(idx, 1);
  if (comments.length === 0) {
    state.delete(event.surfaceId);
  }
  callbacks.onCommentsChanged(event.surfaceId);
}
