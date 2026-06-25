import {
  createComment,
  getComment,
  listComments,
  resolveComment,
} from "../../documents/document-comments-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { canAccessDocument, documentNotFound } from "./document-tool.js";

// ── Exported execute functions ─────────────────────────────────────────

export function executeCommentList(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const surfaceId = input.surface_id as string;

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const comments = listComments(surfaceId, { status: "open" });

  return {
    content: JSON.stringify({
      success: true,
      surface_id: surfaceId,
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author,
        content: c.content,
        anchor_start: c.anchorStart,
        anchor_end: c.anchorEnd,
        anchor_text: c.anchorText,
        parent_comment_id: c.parentCommentId,
        status: c.status,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })),
    }),
    isError: false,
  };
}

export function executeCommentResolve(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const surfaceId = input.surface_id as string;
  const commentId = input.comment_id as string;

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const existing = getComment(commentId);
  if (!existing || existing.surfaceId !== surfaceId) {
    return {
      content: JSON.stringify({
        success: false,
        comment_id: commentId,
        error: "Comment not found",
      }),
      isError: true,
    };
  }

  resolveComment(commentId, "assistant");

  if (context.sendToClient) {
    context.sendToClient({
      type: "document_comment_resolved",
      conversationId: context.conversationId,
      surfaceId,
      commentId,
      resolvedBy: "assistant",
    });
  }

  return {
    content: JSON.stringify({
      success: true,
      comment_id: commentId,
      message: "Comment resolved",
    }),
    isError: false,
  };
}

export function executeCommentReply(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const surfaceId = input.surface_id as string;
  const commentId = input.comment_id as string;
  const content = input.content as string;

  if (!canAccessDocument(surfaceId, context)) {
    return documentNotFound(surfaceId);
  }

  const parent = getComment(commentId);
  if (!parent || parent.surfaceId !== surfaceId) {
    return {
      content: JSON.stringify({
        success: false,
        comment_id: commentId,
        error: "Parent comment not found on this document",
      }),
      isError: true,
    };
  }

  const reply = createComment({
    surfaceId,
    conversationId: context.conversationId,
    author: "assistant",
    content,
    parentCommentId: commentId,
  });

  if (context.sendToClient) {
    context.sendToClient({
      type: "document_comment_created",
      conversationId: context.conversationId,
      surfaceId,
      comment: {
        id: reply.id,
        surfaceId: reply.surfaceId,
        author: reply.author,
        content: reply.content,
        parentCommentId: reply.parentCommentId,
        status: reply.status,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
      },
    });
  }

  return {
    content: JSON.stringify({
      success: true,
      comment: {
        id: reply.id,
        surface_id: reply.surfaceId,
        author: reply.author,
        content: reply.content,
        parent_comment_id: reply.parentCommentId,
        status: reply.status,
        created_at: reply.createdAt,
        updated_at: reply.updatedAt,
      },
    }),
    isError: false,
  };
}
