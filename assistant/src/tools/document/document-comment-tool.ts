import { z } from "zod";

import {
  createComment,
  getComment,
  listComments,
  resolveComment,
} from "../../documents/document-comments-store.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { canAccessDocument, documentNotFound } from "./document-tool.js";

// ── Model-input schemas ────────────────────────────────────────────────
//
// `safeParse`d at the top of each `execute*` — same in-tool pattern and
// drift guard as `document-tool.ts` (see the schema block there for the
// framework). Every advertised-required field is required here; without
// schema rejection a missing/mistyped field would fall through to a
// misleading "Document not found".

export const commentListInputSchema = z.looseObject({
  surface_id: z.string(),
});

export const commentResolveInputSchema = z.looseObject({
  surface_id: z.string(),
  comment_id: z.string(),
});

export const commentReplyInputSchema = z.looseObject({
  surface_id: z.string(),
  comment_id: z.string(),
  content: z.string(),
});

// ── Exported execute functions ─────────────────────────────────────────

export function executeCommentList(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolExecutionResult {
  const parsedInput = commentListInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("comment_list", parsedInput.error);
  }
  const surfaceId = parsedInput.data.surface_id;

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
  const parsedInput = commentResolveInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("comment_resolve", parsedInput.error);
  }
  const { surface_id: surfaceId, comment_id: commentId } = parsedInput.data;

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
  const parsedInput = commentReplyInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("comment_reply", parsedInput.error);
  }
  const {
    surface_id: surfaceId,
    comment_id: commentId,
    content,
  } = parsedInput.data;

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
