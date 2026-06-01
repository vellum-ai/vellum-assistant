/**
 * Hand-written fetch wrappers for assistant memory-item endpoints.
 *
 * These endpoints are served by the assistant daemon via
 * RuntimeProxyWildcardView under /v1/assistants/{id}/memory-items/* and are
 * not part of the Django OpenAPI schema.
 */

import {
  ApiError,
  assertHasResponse,
  client,
  extractErrorMessage,
} from "@/domains/intelligence/client";

import type { MemoryItem, MemoryItemsListResponse } from "./types";

export { ApiError };

export interface FetchMemoriesParams {
  kind?: string;
  status?: string;
  search?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

function buildQuery(params: FetchMemoriesParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.kind) query.kind = params.kind;
  if (params.status) query.status = params.status;
  if (params.search) query.search = params.search;
  if (params.sort) query.sort = params.sort;
  if (params.order) query.order = params.order;
  if (params.limit !== undefined) query.limit = String(params.limit);
  if (params.offset !== undefined) query.offset = String(params.offset);
  return query;
}

export async function fetchMemories(
  assistantId: string,
  params: FetchMemoriesParams = {},
): Promise<MemoryItemsListResponse> {
  const { data, error, response } = await client.get<
    MemoryItemsListResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/memory-items",
    path: { assistant_id: assistantId },
    query: buildQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load memories.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load memories."),
    );
  }
  return data ?? { items: [], total: 0 };
}

interface MemoryItemWrapper {
  item: MemoryItem;
}

export async function fetchMemoryDetail(
  assistantId: string,
  memoryId: string,
): Promise<MemoryItem | null> {
  const { data, error, response } = await client.get<
    MemoryItemWrapper | MemoryItem,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/memory-items/{memory_id}",
    path: { assistant_id: assistantId, memory_id: memoryId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load memory.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load memory."),
    );
  }
  if (!data) return null;
  if ("item" in data) return data.item;
  return data as MemoryItem;
}

export interface UpdateMemoryBody {
  subject?: string;
  statement?: string;
  kind?: string;
  status?: string;
  importance?: number;
  verificationState?: string;
}

export async function updateMemory(
  assistantId: string,
  memoryId: string,
  body: UpdateMemoryBody,
): Promise<MemoryItem> {
  const { data, error, response } = await client.patch<
    MemoryItemWrapper | MemoryItem,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/memory-items/{memory_id}",
    path: { assistant_id: assistantId, memory_id: memoryId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update memory.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to update memory."),
    );
  }
  if (!data) {
    throw new ApiError(response.status, "Failed to update memory.");
  }
  if ("item" in data) return data.item;
  return data as MemoryItem;
}

export async function deleteMemory(
  assistantId: string,
  memoryId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/memory-items/{memory_id}",
    path: { assistant_id: assistantId, memory_id: memoryId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete memory.");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to delete memory."),
    );
  }
}
