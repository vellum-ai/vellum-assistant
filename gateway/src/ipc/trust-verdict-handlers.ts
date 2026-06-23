/**
 * IPC route definitions for gateway-owned per-actor trust verdict reads.
 *
 * Exposes `resolve_inbound_trust` to the assistant daemon over the IPC socket.
 * Resolves the per-actor {@link TrustVerdict} from the gateway ACL DB. This is
 * deliberately a SEPARATE method from `get_channel_admission_policy`: the
 * admission read is channel-scoped + TTL-cached, while this verdict is
 * per-actor and must not share that cache or widen that response.
 */

import {
  makeResolutionFailedVerdict,
  ResolveInboundTrustRequestSchema,
} from "@vellumai/gateway-client";

import { resolveTrustVerdict } from "../risk/trust-verdict-resolver.js";
import { canonicalSenderIdFor } from "../verification/identity.js";
import type { IpcRoute } from "./server.js";

export const trustVerdictRoutes: IpcRoute[] = [
  {
    method: "resolve_inbound_trust",
    schema: ResolveInboundTrustRequestSchema,
    handler: async (params?: Record<string, unknown>) => {
      const input = ResolveInboundTrustRequestSchema.parse(params);
      try {
        return { verdict: await resolveTrustVerdict(input) };
      } catch {
        // Sentinel lets the daemon distinguish a resolver failure from a real
        // stranger.
        return {
          verdict: makeResolutionFailedVerdict(
            canonicalSenderIdFor(input.channelType, input.actorExternalId),
          ),
        };
      }
    },
  },
];
