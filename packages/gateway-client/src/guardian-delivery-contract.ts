/**
 * Shared contract for the gateway-owned guardian binding + delivery pull.
 *
 * The gateway resolves the active guardian binding(s) and their per-channel
 * delivery endpoints from its DB; the daemon pulls them via the
 * `resolve_guardian_delivery` IPC route. INFO (notes / userFile) is NOT
 * carried here — the daemon joins it locally by `contactId`.
 */

import { z } from "zod";

/**
 * IPC request for `resolve_guardian_delivery`. `channelTypes` is an optional
 * filter; omitted ⇒ all active guardian channels.
 */
export const ResolveGuardianDeliveryRequestSchema = z
  .object({
    channelTypes: z.array(z.string()).optional(),
  })
  .default({});

export type ResolveGuardianDeliveryRequest = z.infer<
  typeof ResolveGuardianDeliveryRequestSchema
>;

/**
 * One active guardian binding + delivery endpoint for a single channel.
 */
export const GuardianDeliverySchema = z.object({
  channelType: z.string(),
  contactId: z.string(),
  principalId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  address: z.string(),
  externalChatId: z.string().nullable().optional(),
  status: z.string(),
  verifiedAt: z.number().nullable().optional(),
});

export type GuardianDelivery = z.infer<typeof GuardianDeliverySchema>;

export const ResolveGuardianDeliveryResponseSchema = z.object({
  guardians: z.array(GuardianDeliverySchema),
});

export type ResolveGuardianDeliveryResponse = z.infer<
  typeof ResolveGuardianDeliveryResponseSchema
>;
