/**
 * IPC route definitions for gateway-owned channel admission policy reads.
 *
 * Exposes the resolved per-channel admission policy to the assistant daemon
 * over the IPC socket. Returns `null` when the channel-trust-floors flag is
 * off, the channel is exempt, or the channel type is unknown.
 */

import { isAdmissionPolicyExemptChannel } from "@vellumai/gateway-client";
import { z } from "zod";

import { isChannelId } from "../channels/types.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { getAdmissionPolicyCache } from "../risk/admission-policy-cache.js";
import type { IpcRoute } from "./server.js";

const GetChannelAdmissionPolicySchema = z.object({
  channelType: z.string().min(1),
});

export const admissionPolicyRoutes: IpcRoute[] = [
  {
    method: "get_channel_admission_policy",
    schema: GetChannelAdmissionPolicySchema,
    handler: (params?: Record<string, unknown>) => {
      const { channelType } = GetChannelAdmissionPolicySchema.parse(params);

      if (!isFeatureFlagEnabled("channel-trust-floors")) return { policy: null };
      if (isAdmissionPolicyExemptChannel(channelType)) return { policy: null };
      if (!isChannelId(channelType)) return { policy: null };

      return { policy: getAdmissionPolicyCache().get(channelType) };
    },
  },
];
