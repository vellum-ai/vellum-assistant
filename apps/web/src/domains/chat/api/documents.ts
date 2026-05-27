/**
 * Document CRUD operations via the generated daemon SDK.
 *
 * Wraps the auto-generated daemon client functions with app-specific
 * error handling. Types are re-exported from the generated SDK.
 */

import {
  documentsByIdConversationsPost,
  documentsByIdGet,
  documentsByIdPdfGet,
  documentsGet,
  documentsPost,
} from "@/generated/daemon/sdk.gen";
import type {
  DocumentsByIdGetResponse,
  DocumentsGetResponse,
} from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors";

// ---------------------------------------------------------------------------
// Types — re-exported from generated daemon SDK
// ---------------------------------------------------------------------------

export type DocumentSummary = DocumentsGetResponse["documents"][number];

export type DocumentContent = DocumentsByIdGetResponse;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function fetchDocumentContent(
  assistantId: string,
  documentSurfaceId: string,
): Promise<DocumentContent | null> {
  try {
    const { data, error, response } = await documentsByIdGet({
      path: { assistant_id: assistantId, id: documentSurfaceId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch document.");
    if (!response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function exportDocumentPDF(
  assistantId: string,
  documentSurfaceId: string,
): Promise<Blob | null> {
  try {
    const { response } = await documentsByIdPdfGet({
      path: { assistant_id: assistantId, id: documentSurfaceId },
      throwOnError: false,
      parseAs: "stream",
    });
    if (!response || !response.ok) {
      return null;
    }
    return response.blob();
  } catch {
    return null;
  }
}

export async function listDocuments(
  assistantId: string,
  conversationId?: string,
): Promise<DocumentSummary[]> {
  const { data, error, response } = await documentsGet({
    path: { assistant_id: assistantId },
    query: conversationId ? { conversationId } : undefined,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list documents.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to list documents.",
    );
    throw new ApiError(response.status, msg);
  }
  return data?.documents ?? [];
}

export async function saveDocumentContent(
  assistantId: string,
  surfaceId: string,
  conversationId: string,
  title: string,
  content: string,
): Promise<void> {
  const wordCount = content.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const { error, response } = await documentsPost({
    path: { assistant_id: assistantId },
    body: { surfaceId, conversationId, title, content, wordCount },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save document.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to save document.");
    throw new ApiError(response.status, msg);
  }
}

export async function linkDocumentConversation(
  assistantId: string,
  documentSurfaceId: string,
  conversationId: string,
): Promise<void> {
  const { error, response } = await documentsByIdConversationsPost({
    path: { assistant_id: assistantId, id: documentSurfaceId },
    body: { conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to link document to conversation.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to link document to conversation.",
    );
    throw new ApiError(response.status, msg);
  }
}
