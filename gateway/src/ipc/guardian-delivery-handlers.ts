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
      try {
        return { guardians: resolveGuardianDelivery(input) };
      } catch {
        // Fails soft to [] — guardian delivery is not an admission decision;
        // the daemon owns fallback.
        return { guardians: [] };
      }
    },
  },
];
