/**
 * Per-channel inbound admission floor API
 * (gateway `/v1/assistants/{id}/channel-admission-policy/...`).
 *
 * Mirrors the Swift `ChannelAdmissionPolicyClient` in
 * `clients/shared/Network/ChannelAdmissionPolicyClient.swift` so naming
 * stays in lockstep across surfaces. Internal channels (platform/a2a) and
 * hidden channels (vellum/whatsapp) are filtered client-side — the gateway is
 * already supposed to omit them from the list response, but we double-filter
 * so a future gateway regression can't leak them into the UI.
 */

import {
  assistantChannelAdmissionPolicyList,
  assistantChannelAdmissionPolicySet,
} from "@/generated/gateway/sdk.gen";
import type { AssistantChannelAdmissionPolicyListResponse } from "@/generated/gateway/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import {
  ADMISSION_POLICY_VALUES,
  INTERNAL_CHANNELS,
  isHiddenChannel,
  type AdmissionPolicy,
  type ChannelPolicyView,
} from "./types";

export { ApiError };

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
 * Shape the raw admission-floor list response into client policy views:
 * channels in {@link INTERNAL_CHANNELS} and {@link isHiddenChannel} are
 * dropped, and unknown policy strings coerce to the default. Shared by
 * {@link fetchChannelPolicies} and by the TanStack `select` in the hooks
 * that spread the generated `assistantChannelAdmissionPolicyListOptions`
 * (`useChannelTrustFloors`, `useChannelProvenance`), so every reader keys
 * off the generated query key and one raw cache entry.
 */
export function toChannelPolicyViews(
  data: AssistantChannelAdmissionPolicyListResponse | undefined,
): ChannelPolicyView[] {
  const policies = data?.policies ?? [];
  return policies
    .filter(
      (p) =>
        !isInternalChannel(p.channelType) && !isHiddenChannel(p.channelType),
    )
    .map((p) => ({
      ...p,
      policy: isAdmissionPolicy(p.policy) ? p.policy : "trusted_contacts",
    }));
}

/**
 * List every client-controllable channel's admission floor. Imperative
 * accessor for non-query call sites; React hooks should spread the generated
 * `assistantChannelAdmissionPolicyListOptions` with
 * `select: toChannelPolicyViews` instead.
 */
export async function fetchChannelPolicies(
  assistantId: string,
): Promise<ChannelPolicyView[]> {
  const { data, error, response } = await assistantChannelAdmissionPolicyList({
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
  return toChannelPolicyViews(data);
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
  const { data, error, response } = await assistantChannelAdmissionPolicySet({
    path: { assistant_id: assistantId, channel_type: channelType },
    body: { policy, note: note ?? null },
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
