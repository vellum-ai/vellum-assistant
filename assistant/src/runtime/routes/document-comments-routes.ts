/**
 * Route handlers for document comment CRUD operations.
 *
 * Exposes comment management over HTTP, delegating to the store layer in
 * `documents/document-comments-store.ts`.
 */
import { z } from "zod";

import {
  createComment,
  deleteComment,
  getComment,
  listComments,
  reopenComment,
  resolveComment,
  updateCommentContent,
} from "../../documents/document-comments-store.js";
import { getLogger } from "../../util/logger.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("document-comments-routes");

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z
    .enum(["open", "resolved", "all"])
    .default("all")
    .describe("Filter by comment status"),
});

const createBodySchema = z.object({
  content: z.string().min(1).describe("Comment text content"),
  author: z
    .literal("user")
    .optional()
    .default("user")
    .describe("Comment author"),
  anchorStart: z
    .number()
    .nullable()
    .optional()
    .describe("Selection start offset"),
  anchorEnd: z.number().nullable().optional().describe("Selection end offset"),
  anchorText: z
    .string()
    .nullable()
    .optional()
    .describe("Anchored text snippet"),
  parentCommentId: z
    .string()
    .nullable()
    .optional()
    .describe("Parent comment ID for replies"),
  conversationId: z.string().describe("Owning conversation ID"),
});

const updateBodySchema = z
  .object({
    status: z
      .enum(["open", "resolved"])
      .optional()
      .describe("New comment status"),
    content: z.string().min(1).optional().describe("Updated comment text"),
    resolvedBy: z.string().optional().describe("Who resolved the comment"),
  })
  .refine((data) => data.status !== undefined || data.content !== undefined, {
    message: "At least one of status or content must be provided",
  });

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

/**
 * Wire shape of a stored comment, mirroring the `CommentRecord` returned by
 * the store layer. Shared by the list, create, and update responses so the
 * generated client and OpenAPI spec describe the full comment rather than an
 * erased `unknown`.
 */
const documentCommentSchema = z.object({
  id: z.string(),
  surfaceId: z.string(),
  conversationId: z.string(),
  author: z.string(),
  content: z.string(),
  anchorStart: z.number().nullable(),
  anchorEnd: z.number().nullable(),
  anchorText: z.string().nullable(),
  parentCommentId: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listDocumentComments",
    endpoint: "documents/:id/comments",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List comments for a document",
    description:
      "Return comments for a document, optionally filtered by status.",
    tags: ["documents"],
    queryParams: [
      {
        name: "status",
        schema: { type: "string", enum: ["open", "resolved", "all"] },
        description: "Filter by comment status (default: all)",
      },
    ],
    responseBody: z.object({
      comments: z.array(documentCommentSchema).describe("Comment records"),
    }),
    handler: ({ pathParams, queryParams }) => {
      const parsed = listQuerySchema.safeParse(queryParams ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0].message);
      }
      const { status } = parsed.data;
      const comments = listComments(pathParams!.id, { status });
      return { comments };
    },
  },

  {
    operationId: "createDocumentComment",
    endpoint: "documents/:id/comments",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a comment on a document",
    description: "Add a new comment to a document.",
    tags: ["documents"],
    requestBody: createBodySchema,
    responseBody: documentCommentSchema,
    handler: ({ pathParams, body }) => {
      const parsed = createBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0].message);
      }
      const {
        content,
        author,
        anchorStart,
        anchorEnd,
        anchorText,
        parentCommentId,
        conversationId,
      } = parsed.data;
      const comment = createComment({
        surfaceId: pathParams!.id,
        conversationId,
        author,
        content,
        anchorStart,
        anchorEnd,
        anchorText,
        parentCommentId,
      });
      broadcastMessage(
        {
          type: "document_comment_created",
          conversationId,
          surfaceId: pathParams!.id,
          comment: {
            id: comment.id,
            surfaceId: comment.surfaceId,
            author: comment.author,
            content: comment.content,
            anchorStart: comment.anchorStart ?? undefined,
            anchorEnd: comment.anchorEnd ?? undefined,
            anchorText: comment.anchorText ?? undefined,
            parentCommentId: comment.parentCommentId ?? undefined,
            status: comment.status,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          },
        },
        conversationId,
      );
      log.info(
        { id: comment.id, surfaceId: pathParams!.id },
        "Created document comment via HTTP",
      );
      return comment;
    },
  },

  {
    operationId: "updateDocumentComment",
    endpoint: "documents/:id/comments/:commentId",
    method: "PATCH",
    policy: null,
    summary: "Update a document comment",
    description: "Update the status or content of a comment.",
    tags: ["documents"],
    requestBody: updateBodySchema,
    responseBody: documentCommentSchema,
    handler: ({ pathParams, body }) => {
      const parsed = updateBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0].message);
      }
      const { status, content, resolvedBy } = parsed.data;
      const commentId = pathParams!.commentId;

      const existing = getComment(commentId);
      if (!existing || existing.surfaceId !== pathParams!.id) {
        throw new NotFoundError("Comment not found");
      }

      if (status === "resolved") {
        resolveComment(commentId, resolvedBy ?? "user");
        broadcastMessage(
          {
            type: "document_comment_resolved",
            conversationId: existing.conversationId,
            surfaceId: pathParams!.id,
            commentId,
            resolvedBy: resolvedBy ?? "user",
          },
          existing.conversationId,
        );
      } else if (status === "open") {
        reopenComment(commentId);
        broadcastMessage(
          {
            type: "document_comment_reopened",
            conversationId: existing.conversationId,
            surfaceId: pathParams!.id,
            commentId,
          },
          existing.conversationId,
        );
      }

      if (content !== undefined) {
        updateCommentContent(commentId, content);
      }

      const updated = getComment(commentId);
      if (!updated) {
        throw new NotFoundError("Comment not found after update");
      }

      log.info(
        { id: commentId, surfaceId: pathParams!.id },
        "Updated document comment via HTTP",
      );
      return updated;
    },
  },

  {
    operationId: "deleteDocumentComment",
    endpoint: "documents/:id/comments/:commentId",
    method: "DELETE",
    policy: null,
    summary: "Delete a document comment",
    description: "Permanently delete a comment.",
    tags: ["documents"],
    responseBody: z.object({
      success: z.literal(true),
    }),
    handler: ({ pathParams }) => {
      const commentId = pathParams!.commentId;
      const existing = getComment(commentId);
      if (!existing || existing.surfaceId !== pathParams!.id) {
        throw new NotFoundError("Comment not found");
      }
      deleteComment(commentId);
      broadcastMessage(
        {
          type: "document_comment_deleted",
          conversationId: existing.conversationId,
          surfaceId: pathParams!.id,
          commentId,
        },
        existing.conversationId,
      );
      log.info(
        { id: commentId, surfaceId: pathParams!.id },
        "Deleted document comment via HTTP",
      );
      return { success: true as const };
    },
  },
];
