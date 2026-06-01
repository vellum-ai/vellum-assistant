import { client } from "@/generated/api/client.gen";

import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentComment {
  id: string;
  surfaceId: string;
  conversationId: string;
  author: "user" | "assistant";
  content: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  anchorText: string | null;
  parentCommentId: string | null;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ListCommentsResponse {
  comments: DocumentComment[];
}

export interface CreateCommentParams {
  content: string;
  conversationId: string;
  anchorStart?: number;
  anchorEnd?: number;
  anchorText?: string;
  parentCommentId?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function fetchComments(
  assistantId: string,
  surfaceId: string,
  status?: "open" | "resolved",
): Promise<DocumentComment[]> {
  const query: Record<string, string> = {};
  if (status) {
    query.status = status;
  }
  const { data, error, response } = await client.get<
    ListCommentsResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/documents/{document_id}/comments",
    path: { assistant_id: assistantId, document_id: surfaceId },
    query,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch comments.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch comments.",
    );
    throw new ApiError(response.status, msg);
  }
  const payload = data as ListCommentsResponse | undefined;
  return payload?.comments ?? [];
}

export async function createComment(
  assistantId: string,
  surfaceId: string,
  params: CreateCommentParams,
): Promise<DocumentComment> {
  const { data, error, response } = await client.post<
    DocumentComment & { success: boolean },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/documents/{document_id}/comments",
    path: { assistant_id: assistantId, document_id: surfaceId },
    body: params,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to create comment.");
  if (!response.ok || !data) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to create comment.",
    );
    throw new ApiError(response.status, msg);
  }
  return data;
}

async function patchCommentStatus(
  assistantId: string,
  surfaceId: string,
  commentId: string,
  status: "open" | "resolved",
): Promise<DocumentComment> {
  const label = status === "resolved" ? "resolve" : "reopen";
  const { data, error, response } = await client.patch<
    DocumentComment & { success: boolean },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/documents/{document_id}/comments/{comment_id}",
    path: {
      assistant_id: assistantId,
      document_id: surfaceId,
      comment_id: commentId,
    },
    body: { status },
    throwOnError: false,
  });
  assertHasResponse(response, error, `Failed to ${label} comment.`);
  if (!response.ok || !data) {
    const msg = extractErrorMessage(
      error,
      response,
      `Failed to ${label} comment.`,
    );
    throw new ApiError(response.status, msg);
  }
  return data;
}

export async function resolveComment(
  assistantId: string,
  surfaceId: string,
  commentId: string,
): Promise<DocumentComment> {
  return patchCommentStatus(assistantId, surfaceId, commentId, "resolved");
}

export async function reopenComment(
  assistantId: string,
  surfaceId: string,
  commentId: string,
): Promise<DocumentComment> {
  return patchCommentStatus(assistantId, surfaceId, commentId, "open");
}

export async function deleteComment(
  assistantId: string,
  surfaceId: string,
  commentId: string,
): Promise<{ success: boolean }> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/documents/{document_id}/comments/{comment_id}",
    path: {
      assistant_id: assistantId,
      document_id: surfaceId,
      comment_id: commentId,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete comment.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to delete comment.",
    );
    throw new ApiError(response.status, msg);
  }
  return { success: true };
}
