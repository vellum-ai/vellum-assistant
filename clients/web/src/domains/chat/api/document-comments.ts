import {
  documentsByIdCommentsByCommentIdDelete,
  documentsByIdCommentsByCommentIdPatch,
  documentsByIdCommentsGet,
  documentsByIdCommentsPost,
} from "@/generated/daemon/sdk.gen";
import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
): Promise<DocumentsByIdCommentsPostResponse[]> {
  const { data, error, response } = await documentsByIdCommentsGet({
    path: { assistant_id: assistantId, id: surfaceId },
    query: status ? { status } : {},
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
  return data?.comments ?? [];
}

export async function createComment(
  assistantId: string,
  surfaceId: string,
  params: CreateCommentParams,
): Promise<DocumentsByIdCommentsPostResponse> {
  const { data, error, response } = await documentsByIdCommentsPost({
    path: { assistant_id: assistantId, id: surfaceId },
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
): Promise<DocumentsByIdCommentsPostResponse> {
  const label = status === "resolved" ? "resolve" : "reopen";
  const { data, error, response } = await documentsByIdCommentsByCommentIdPatch(
    {
      path: {
        assistant_id: assistantId,
        id: surfaceId,
        commentId,
      },
      body: { status },
      throwOnError: false,
    },
  );
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
): Promise<DocumentsByIdCommentsPostResponse> {
  return patchCommentStatus(assistantId, surfaceId, commentId, "resolved");
}

export async function reopenComment(
  assistantId: string,
  surfaceId: string,
  commentId: string,
): Promise<DocumentsByIdCommentsPostResponse> {
  return patchCommentStatus(assistantId, surfaceId, commentId, "open");
}

export async function deleteComment(
  assistantId: string,
  surfaceId: string,
  commentId: string,
): Promise<{ success: boolean }> {
  const { error, response } = await documentsByIdCommentsByCommentIdDelete({
    path: {
      assistant_id: assistantId,
      id: surfaceId,
      commentId,
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
