/**
 * Test-only resolver that mirrors the gateway's active-guardian-channel query.
 *
 * Production resolves the guardian binding + per-channel delivery endpoints from
 * the gateway (`gateway/src/risk/guardian-delivery-resolver.ts`, reached via the
 * `resolve_guardian_delivery` IPC route) — `role = 'guardian'` joined to active
 * gateway contact channels, returning EVERY active row ordered by `verifiedAt`
 * desc, optionally narrowed to `channelTypes` (empty array = unfiltered). Tests
 * seed that gateway state via {@link seedContactChannel} / `createGuardianBinding`
 * into the in-process gateway ACL store ({@link gatewayAclRows}); this resolver
 * reads the SAME store so the gateway-derived delivery list reflects the seeded
 * binding. No assistant ACL columns are read here — the ACL is gateway-owned.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";

import { gatewayAclRows } from "./gateway-acl-store.js";

/**
 * Resolve active guardian deliveries from the gateway ACL store, optionally
 * filtered to a single channel (when `channelType` is given) or to a set of
 * channel types (when `channelTypes` is given). Mirrors the gateway resolution:
 * `role = 'guardian'` joined to active channels, returning ALL active rows
 * ordered by verification recency. An empty `channelTypes` array means
 * unfiltered (all types), matching the production resolver.
 */
export function deriveGuardianDeliveries(filter?: {
  channelType?: string;
  channelTypes?: string[];
}): GuardianDelivery[] {
  const channelTypes =
    filter?.channelTypes ??
    (filter?.channelType !== undefined ? [filter.channelType] : undefined);

  return gatewayAclRows()
    .filter((r) => {
      if (r.role !== "guardian" || r.status !== "active") return false;
      // Empty array => no filter (all types), matching production's
      // `channelTypes.length > 0` predicate guard.
      if (channelTypes && channelTypes.length > 0) {
        return channelTypes.includes(r.channelType);
      }
      return true;
    })
    .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0))
    .map((r) => ({
      channelType: r.channelType,
      contactId: r.contactId,
      principalId: r.principalId ?? null,
      displayName: r.displayName ?? null,
      address: r.address,
      externalChatId: r.externalChatId ?? null,
      status: "active",
      verifiedAt: r.verifiedAt ?? null,
    }));
}

/**
 * The single active guardian delivery for a channel type, mirroring the
 * gateway's per-channel resolution (most-recently-verified wins).
 */
export function deriveGuardianForChannel(
  channelType: string,
): GuardianDelivery | null {
  return deriveGuardianDeliveries({ channelType })[0] ?? null;
}
