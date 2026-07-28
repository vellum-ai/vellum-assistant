/**
 * Permission threshold CRUD for global and per-conversation overrides.
 *
 * These endpoints are gateway-native (`/v1/assistants/{id}/permissions/…`)
 * and are called through the generated gateway SDK: the schemas live on the
 * gateway's route metadata (`gateway/src/http/routes/
 * auto-approve-thresholds-routes.ts`), so the request/response types here
 * are codegen-derived rather than hand-written. The gateway client's
 * interceptor routes to the self-hosted gateway in local mode and through
 * the platform proxy for platform-hosted assistants.
 */

import {
  assistantConversationThresholdDelete,
  assistantConversationThresholdGet,
  assistantConversationThresholdPut,
  assistantPermissionsThresholdsGet,
  assistantPermissionsThresholdsPut,
} from "@/generated/gateway/sdk.gen";
import type {
  AssistantPermissionsThresholdsGetResponse,
  AssistantPermissionsThresholdsPutData,
} from "@/generated/gateway/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type GlobalThresholds = AssistantPermissionsThresholdsGetResponse;

export async function getGlobalThresholds(
  assistantId: string,
): Promise<GlobalThresholds> {
  const { data, error, response } = await assistantPermissionsThresholdsGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch global thresholds.");
  if (!response.ok || !data) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to fetch global thresholds.",
    );
    throw new ApiError(response.status, msg);
  }
  return data;
}

export async function setGlobalThresholds(
  assistantId: string,
  thresholds: AssistantPermissionsThresholdsPutData["body"],
): Promise<GlobalThresholds> {
  const { data, error, response } = await assistantPermissionsThresholdsPut({
    path: { assistant_id: assistantId },
    body: thresholds,
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update global thresholds.");
  if (!response.ok || !data) {
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to update global thresholds.",
    );
    throw new ApiError(response.status, msg);
  }
  return data;
}

export async function getConversationOverride(
  assistantId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error, response } = await assistantConversationThresholdGet({
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
  return data?.threshold ?? null;
}

export async function setConversationOverride(
  assistantId: string,
  conversationId: string,
  threshold: GlobalThresholds["interactive"],
): Promise<void> {
  const { error, response } = await assistantConversationThresholdPut({
    path: { assistant_id: assistantId, conversation_id: conversationId },
    body: { threshold },
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
  const { error, response } = await assistantConversationThresholdDelete({
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
