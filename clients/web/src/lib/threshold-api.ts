/**
 * Permission threshold CRUD for global and per-conversation overrides.
 *
 * These endpoints live on the gateway (`/v1/assistants/{id}/permissions/…`),
 * not the daemon, and are not yet part of any generated OpenAPI spec. The
 * functions here use the raw HeyAPI client until gateway codegen is wired up.
 */

import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export interface GlobalThresholds {
  interactive: string;
  autonomous: string;
  headless: string;
}

export async function getGlobalThresholds(
  assistantId: string,
): Promise<GlobalThresholds> {
  const { data, error, response } = await client.get<GlobalThresholds, unknown>(
    {
      url: "/v1/assistants/{assistant_id}/permissions/thresholds",
      path: { assistant_id: assistantId },
      throwOnError: false,
    },
  );
  assertHasResponse(response, error, "Failed to fetch global thresholds.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch global thresholds.",
    );
    throw new ApiError(response.status, msg);
  }
  const result = data as GlobalThresholds;
  return {
    interactive: result.interactive ?? "medium",
    autonomous: result.autonomous ?? "low",
    headless: result.headless ?? "none",
  };
}

export async function setGlobalThresholds(
  assistantId: string,
  thresholds: { interactive?: string; autonomous?: string; headless?: string },
): Promise<GlobalThresholds> {
  const { data, error, response } = await client.put<GlobalThresholds, unknown>(
    {
      url: "/v1/assistants/{assistant_id}/permissions/thresholds",
      path: { assistant_id: assistantId },
      body: thresholds,
      headers: { "Content-Type": "application/json" },
      throwOnError: false,
    },
  );
  assertHasResponse(response, error, "Failed to update global thresholds.");
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to update global thresholds.",
    );
    throw new ApiError(response.status, msg);
  }
  const result = data as GlobalThresholds;
  return {
    interactive: result.interactive ?? "medium",
    autonomous: result.autonomous ?? "low",
    headless: result.headless ?? "none",
  };
}

export async function getConversationOverride(
  assistantId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error, response } = await client.get<
    { threshold: string | null },
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/permissions/thresholds/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    throwOnError: false,
  });
  // Older gateways returned 404 to signal "no override exists" for the
  // given conversation. Newer gateways return 200 with `{ threshold: null }`
  // for the same condition (cleaner — keeps the browser console quiet for
  // the common case). Treat both as a successful "no override" result so
  // the client stays compatible across the rollout.
  if (response?.status === 404) {
    return null;
  }
  assertHasResponse(
    response,
    error,
    "Failed to fetch conversation threshold override.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch conversation threshold override.",
    );
    throw new ApiError(response.status, msg);
  }
  const result = data as unknown as { threshold: string | null };
  return result.threshold ?? null;
}

export async function setConversationOverride(
  assistantId: string,
  conversationId: string,
  threshold: string,
): Promise<void> {
  const { error, response } = await client.put<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/permissions/thresholds/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    body: { threshold },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to set conversation threshold override.",
  );
  if (!response.ok) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to set conversation threshold override.",
    );
    throw new ApiError(response.status, msg);
  }
}

export async function deleteConversationOverride(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    url: "/v1/assistants/{assistant_id}/permissions/thresholds/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Failed to delete conversation threshold override.",
  );
  if (!response.ok && response.status !== 204) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to delete conversation threshold override.",
    );
    throw new ApiError(response.status, msg);
  }
}
