import { useQuery } from "@tanstack/react-query";

import type { CascadeProvenance } from "@/domains/contacts/components/provenance-pill";
import { isSetupChannelId, type SetupChannelId } from "@/domains/contacts/types";
import { assistantChannelAdmissionPolicyListOptions } from "@/generated/gateway/@tanstack/react-query.gen";
import type { AssistantChannelAdmissionPolicyListResponse } from "@/generated/gateway/types.gen";
import {
  ADMISSION_POLICY_DEFAULT,
  type ChannelPolicyView,
} from "@/lib/channel-admission-policy/types";
import { toChannelPolicyViews } from "@/lib/channel-admission-policy/api";

export type ChannelProvenanceMap = Partial<
  Record<SetupChannelId, CascadeProvenance>
>;

/**
 * Derive per-channel cascade provenance from the admission-floor list.
 *
 * Provenance is decided by value, not by row metadata: the gateway seeds a
 * row for every enforced channel at startup with a real `updatedAt`
 * timestamp (`seedAdmissionPolicyDefaults`), so a stored row — even a
 * recently-stamped one — does not imply the user set a channel-level floor.
 * A floor that differs from the global default is definitionally
 * channel-set; a floor equal to it renders as the global default.
 */
export function deriveChannelProvenance(
  policies: ChannelPolicyView[],
): ChannelProvenanceMap {
  const map: ChannelProvenanceMap = {};
  for (const policy of policies) {
    if (!isSetupChannelId(policy.channelType)) {
      continue;
    }
    map[policy.channelType] =
      policy.policy !== ADMISSION_POLICY_DEFAULT
        ? { source: "channel-default", channel: policy.channelType }
        : { source: "global-default" };
  }
  return map;
}

function selectChannelProvenance(
  data: AssistantChannelAdmissionPolicyListResponse,
): ChannelProvenanceMap {
  return deriveChannelProvenance(toChannelPolicyViews(data));
}

/**
 * Per-channel cascade provenance for the contact detail's channel rows —
 * whether each setup channel's admission floor comes from the global default
 * or a channel-level default set on the Channels tab (see
 * {@link deriveChannelProvenance} for the decision rule).
 *
 * Spreads the generated `assistantChannelAdmissionPolicyListOptions` so it
 * shares the generated query key — and one raw cache entry — with
 * `useChannelTrustFloors`.
 */
export function useChannelProvenance(
  assistantId: string,
): ChannelProvenanceMap | undefined {
  const enabled = Boolean(assistantId);

  const query = useQuery({
    ...assistantChannelAdmissionPolicyListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled,
    select: selectChannelProvenance,
  });

  return enabled ? query.data : undefined;
}
