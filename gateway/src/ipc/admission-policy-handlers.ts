/**
 * IPC route definitions for gateway-owned channel admission policy reads.
 *
 * Exposes the resolved per-channel admission policy to the assistant daemon
 * over the IPC socket. Returns `null` when the channel-trust-floors flag is
 * off, the channel is exempt, or the channel type is unknown.
 */

import { z } from "zod";

import { resolveAdmissionPolicy } from "../risk/admission-policy-cache.js";
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
      return { policy: resolveAdmissionPolicy(channelType) };
    },
  },
];
