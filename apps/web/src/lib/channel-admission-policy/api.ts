/**
 * Per-channel inbound admission floor + per-conversation override API
 * (gateway `/v1/assistants/{id}/channel-admission-policy/...`).
 *
 * Mirrors the Swift `ChannelAdmissionPolicyClient` in
 * `clients/shared/Network/ChannelAdmissionPolicyClient.swift` so naming
 * stays in lockstep across surfaces. Internal channels (vellum/platform/a2a)
 * are filtered client-side per §8.1 — the gateway is already supposed to
 * omit them from the list response, but we double-filter so a future
 * gateway regression can't leak them into the UI.
 */

import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import {
  ADMISSION_POLICY_VALUES,
  INTERNAL_CHANNELS,
  type AdmissionPolicy,
  type ChannelPolicyView,
  type ConversationOverrideView,
} from "./types";

export { ApiError };

interface ListResponse {
  policies: ChannelPolicyView[];
}

interface SingleResponse {
  policy: ChannelPolicyView;
}

interface ConversationResponse {
  override: ConversationOverrideView;
}

function isAdmissionPolicy(value: unknown): value is AdmissionPolicy {
  return (
    typeof value === "string" &&
    (ADMISSION_POLICY_VALUES as readonly string[]).includes(value)
  );
}

export function isInternalChannel(channelType: string): boolean {
  return INTERNAL_CHANNELS.has(channelType);
}

/**
 * List every client-controllable channel's admission floor.
 *
 * Channels in {@link INTERNAL_CHANNELS} are filtered out before returning,
 * so callers can render the result directly without re-filtering.
 */
export async function fetchChannelPolicies(
  assistantId: string,
): Promise<ChannelPolicyView[]> {
  const { data, error, response } = await client.get<ListResponse, unknown>({
    url: "/v1/assistants/{assistant_id}/channel-admission-policy/",
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load channel policies.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load channel policies."),
    );
  }
  const policies = data?.policies ?? [];
  return policies
    .filter((p) => !isInternalChannel(p.channelType))
    .map((p) => ({
      ...p,
      policy: isAdmissionPolicy(p.policy) ? p.policy : "trusted_contacts",
    }));
}

export async function setChannelPolicy(
  assistantId: string,
  channelType: string,
  policy: AdmissionPolicy,
  note?: string | null,
): Promise<ChannelPolicyView> {
  if (isInternalChannel(channelType)) {
    // Client-side guard so the UI never even sends the request. The gateway
    // also enforces this — we're just being a good citizen and giving the
    // user a clear local error instead of a server 4xx round trip.
    throw new ApiError(
      403,
      `Channel "${channelType}" is internal and is not user-configurable.`,
    );
  }
  const { data, error, response } = await client.put<SingleResponse, unknown>({
    url: "/v1/assistants/{assistant_id}/channel-admission-policy/{channel_type}",
    path: { assistant_id: assistantId, channel_type: channelType },
    body: { policy, note: note ?? null },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save channel policy.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to save channel policy."),
    );
  }
  if (!data?.policy) {
    throw new ApiError(500, "Gateway returned no policy in response.");
  }
  return data.policy;
}

/**
 * Read the override for a single conversation. Returns `null` for the
 * `override` field when no override exists; the gateway always supplies the
 * current type-floor so the picker can render the divergence warning.
 */
export async function fetchConversationOverride(
  assistantId: string,
  conversationId: string,
): Promise<ConversationOverrideView> {
  const { data, error, response } = await client.get<
    ConversationResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/channel-admission-policy/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load conversation override.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to load conversation override.",
      ),
    );
  }
  if (!data?.override) {
    throw new ApiError(500, "Gateway returned no override in response.");
  }
  return data.override;
}

export async function setConversationOverride(
  assistantId: string,
  conversationId: string,
  floor: AdmissionPolicy | null,
  channelType?: string | null,
): Promise<ConversationOverrideView> {
  // §8.1: client-side guard — exempt channels are not user-configurable.
  if (channelType && isInternalChannel(channelType)) {
    throw new ApiError(
      403,
      `Channel "${channelType}" is internal and is not user-configurable.`,
    );
  }
  const { data, error, response } = await client.put<
    ConversationResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/channel-admission-policy/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    body: { floor, channelType: channelType ?? null },
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to save conversation override.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to save conversation override.",
      ),
    );
  }
  if (!data?.override) {
    throw new ApiError(500, "Gateway returned no override in response.");
  }
  return data.override;
}

/**
 * Delete the per-conversation admission override, reverting to the channel
 * type floor. The gateway returns the post-delete view with `override: null`.
 */
export async function resetConversationOverride(
  assistantId: string,
  conversationId: string,
): Promise<ConversationOverrideView> {
  const { data, error, response } = await client.delete<
    ConversationResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/channel-admission-policy/conversations/{conversation_id}",
    path: { assistant_id: assistantId, conversation_id: conversationId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to reset conversation override.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Failed to reset conversation override.",
      ),
    );
  }
  if (!data?.override) {
    throw new ApiError(500, "Gateway returned no override in response.");
  }
  return data.override;
}
