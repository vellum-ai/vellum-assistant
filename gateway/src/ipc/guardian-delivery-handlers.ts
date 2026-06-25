/**
 * IPC route definitions for gateway-owned guardian binding + delivery reads.
 *
 * Exposes `resolve_guardian_delivery` to the assistant daemon over the IPC
 * socket: returns every active guardian binding + delivery endpoint from the
 * gateway ACL DB.
 */

import { ResolveGuardianDeliveryRequestSchema } from "@vellumai/gateway-client";

import { resolveGuardianDelivery } from "../risk/guardian-delivery-resolver.js";
import type { IpcRoute } from "./server.js";

export const guardianDeliveryRoutes: IpcRoute[] = [
  {
    method: "resolve_guardian_delivery",
    schema: ResolveGuardianDeliveryRequestSchema,
    handler: async (params?: Record<string, unknown>) => {
      const input = ResolveGuardianDeliveryRequestSchema.parse(params);
      // Let a resolver error propagate: the IPC server turns it into an error
      // envelope, which the daemon reader maps to `null` ("couldn't
      // determine"). A successful resolve with no active guardian returns `[]`
      // (authoritative no-guardian). This distinction lets the daemon's
      // existence guards apply their null fail-safe on a gateway DB error
      // instead of mis-reading it as "no guardian".
      return { guardians: resolveGuardianDelivery(input) };
    },
  },
];
