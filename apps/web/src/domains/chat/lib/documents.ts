import { client } from "@/generated/api/client.gen.js";

import "@/lib/api-client.js";

import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api-errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  surfaceId: string;
  conversationId: string;
  title: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
}

interface ListDocumentsResponse {
  documents: DocumentSummary[];
}

// ---------------------------------------------------------------------------
// SDK base options — same pattern as chat/apps.ts
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export interface DocumentContent {
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function fetchDocumentContent(
  assistantId: string,
  documentSurfaceId: string,
): Promise<DocumentContent | null> {
  try {
    const { data, error, response } = await client.get<
      DocumentContent & { success: boolean },
      unknown
    >({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/documents/{document_id}",
      path: { assistant_id: assistantId, document_id: documentSurfaceId },
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
    const { response } = await client.get<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/documents/{document_id}/pdf",
      path: { assistant_id: assistantId, document_id: documentSurfaceId },
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
  const query: Record<string, string> = {};
  if (conversationId) {
    query.conversationId = conversationId;
  }
  const { data, error, response } = await client.get<
    ListDocumentsResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/documents",
    path: { assistant_id: assistantId },
    query,
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
  const payload = data as ListDocumentsResponse | undefined;
  return payload?.documents ?? [];
}
