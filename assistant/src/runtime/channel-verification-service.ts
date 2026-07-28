/**
 * Guardian-delivery reads for channel verification.
 *
 * The verification session lifecycle (creation, secrets, validate+consume,
 * rate limits) is gateway-owned — see
 * `assistant/src/channels/gateway-verification-sessions.ts` for the IPC
 * client. What remains here are the daemon-side reads over the
 * gateway-owned GuardianDelivery contract: binding lookups and
 * guardian-identity checks.
 */

import {
  getGuardianDelivery,
  getGuardianDeliveryFresh,
  guardianForChannel,
} from "../contacts/guardian-delivery-reader.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Re-exported for consumers that reason about "is a just-issued code still
// redeemable" (e.g. the access-request handshake window).
export { CHALLENGE_TTL_MS } from "@vellumai/gateway-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingStatus = "active" | "revoked";

/**
 * Guardian binding synthesized from the gateway-owned GuardianDelivery
 * contract (there is no daemon binding table).
 */
export interface GuardianBinding {
  id: string;
  assistantId: string;
  channel: string;
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
  /**
   * Canonical principal from the gateway guardian contact. `null` when the
   * gateway row carries no principal — callers must treat that as UNRESOLVED
   * (repair via the vellum anchor / adopt path), never as an empty principal.
   */
  guardianPrincipalId: string | null;
  status: BindingStatus;
  verifiedAt: number;
  verifiedVia: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Guardian-delivery reads
// ---------------------------------------------------------------------------

/**
 * Look up the active guardian binding for a given assistant and channel.
 * Reads the gateway-owned GuardianDelivery and synthesizes a
 * GuardianBinding-shaped object. Returns null when no guardian is bound or
 * the gateway is unreachable.
 */
export async function getGuardianBinding(
  assistantId: string,
  channel: string,
): Promise<GuardianBinding | null> {
  const list = await getGuardianDelivery({ channelTypes: [channel] });
  const delivery = list ? guardianForChannel(list, channel) : undefined;
  if (!delivery) return null;

  const now = Date.now();
  return {
    id: delivery.contactId,
    assistantId,
    channel,
    guardianExternalUserId: delivery.address,
    guardianDeliveryChatId: delivery.externalChatId ?? "",
    // A missing principal is surfaced as null (unresolved), never coerced to
    // an empty string that would masquerade as a present-but-empty principal.
    guardianPrincipalId: delivery.principalId ?? null,
    status: "active" as const,
    verifiedAt: delivery.verifiedAt ?? 0,
    // verifiedVia is not carried on the delivery contract; a bound guardian
    // is verified by definition.
    verifiedVia: "verified",
    metadataJson: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Gateway-backed guardian-existence check: is a guardian already bound for
 * this channel? Presence-only idempotency guard, NOT an ACL-field read.
 *
 * Null-list fail direction: a `null` from the gateway (unreachable / malformed)
 * is "unknown" — returns `true` so an unreachable gateway is treated as
 * already-bound. Callers gate session creation on a falsy result, so this
 * blocks a new binding on a transient miss rather than spuriously creating a
 * second one.
 */
export async function isGuardianBoundForChannel(
  channel: string,
): Promise<boolean> {
  // Existence guards read fresh because gateway-side binding writes don't
  // invalidate the daemon cache.
  const list = await getGuardianDeliveryFresh({ channelTypes: [channel] });
  if (list === null) return true;
  return !!guardianForChannel(list, channel);
}

/**
 * Check whether the given external user is the active guardian for
 * the specified assistant and channel.
 */
export async function isGuardian(
  assistantId: string,
  channel: string,
  address: string,
): Promise<boolean> {
  const list = await getGuardianDelivery({ channelTypes: [channel] });
  const delivery = list ? guardianForChannel(list, channel) : undefined;
  if (!delivery) return false;

  return delivery.address.toLowerCase() === address.toLowerCase();
}
