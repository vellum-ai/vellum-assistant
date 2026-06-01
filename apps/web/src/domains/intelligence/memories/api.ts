/**
 * Fetch wrappers for assistant memory-item endpoints.
 *
 * Uses the daemon SDK for routing — all calls go through daemonClient,
 * which forwards unconditionally to the self-hosted gateway.
 *
 * Hand-written types (`./types`) are kept because the generated response
 * types use `Array<unknown>` / `{ [key: string]: unknown }` for items.
 */

import {
  memoryitemsByIdDelete,
  memoryitemsByIdGet,
  memoryitemsByIdPatch,
  memoryitemsGet,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

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

export async function fetchMemories(
  assistantId: string,
  params: FetchMemoriesParams = {},
): Promise<MemoryItemsListResponse> {
  const { data, error, response } = await memoryitemsGet({
    path: { assistant_id: assistantId },
    query: params,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load memories.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load memories."),
    );
  }
  return (data as MemoryItemsListResponse) ?? { items: [], total: 0 };
}

export async function fetchMemoryDetail(
  assistantId: string,
  memoryId: string,
): Promise<MemoryItem | null> {
  const { data, error, response } = await memoryitemsByIdGet({
    path: { assistant_id: assistantId, id: memoryId },
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
  return data.item as unknown as MemoryItem;
}

export interface UpdateMemoryBody {
  subject?: string;
  statement?: string;
  kind?: string;
  status?: string;
  importance?: number;
}

export async function updateMemory(
  assistantId: string,
  memoryId: string,
  body: UpdateMemoryBody,
): Promise<MemoryItem> {
  const { data, error, response } = await memoryitemsByIdPatch({
    path: { assistant_id: assistantId, id: memoryId },
    body,
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
  return data.item as unknown as MemoryItem;
}

export async function deleteMemory(
  assistantId: string,
  memoryId: string,
): Promise<void> {
  const { error, response } = await memoryitemsByIdDelete({
    path: { assistant_id: assistantId, id: memoryId },
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
