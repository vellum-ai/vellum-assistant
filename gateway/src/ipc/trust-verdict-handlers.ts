/**
 * IPC route definitions for gateway-owned per-actor trust verdict reads.
 *
 * Exposes `resolve_inbound_trust` to the assistant daemon over the IPC socket.
 * Resolves the per-actor {@link TrustVerdict} from the gateway ACL DB and
 * carries the channel's admission policy alongside it as an ENVELOPE field
 * (resolved from the same store `get_channel_admission_policy` reads), so
 * voice setup needs a single gateway round-trip. The policy stays off the
 * shared verdict schema — the verdict is also stamped on every text relay.
 */

import {
  makeResolutionFailedVerdict,
  ResolveInboundTrustRequestSchema,
} from "@vellumai/gateway-client";

import { resolveAdmissionPolicy } from "../risk/admission-policy-cache.js";
import { resolveTrustVerdict } from "../risk/trust-verdict-resolver.js";
import { canonicalSenderIdFor } from "../verification/identity.js";
import type { IpcRoute } from "./server.js";

export const trustVerdictRoutes: IpcRoute[] = [
  {
    method: "resolve_inbound_trust",
    schema: ResolveInboundTrustRequestSchema,
    handler: async (params?: Record<string, unknown>) => {
      const input = ResolveInboundTrustRequestSchema.parse(params);
      // Sentinel lets the daemon distinguish a resolver failure from a real
      // stranger.
      const verdict = await resolveTrustVerdict(input).catch(() =>
        makeResolutionFailedVerdict(
          canonicalSenderIdFor(input.channelType, input.actorExternalId),
        ),
      );
      // A thrown admission read propagates and fails the whole IPC call: the
      // daemon must deny fail-closed rather than admit on a fabricated null
      // ("no enforcement") policy.
      return {
        verdict,
        admissionPolicy: resolveAdmissionPolicy(input.channelType),
      };
    },
  },
];
