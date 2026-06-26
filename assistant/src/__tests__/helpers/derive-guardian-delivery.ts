/**
 * Test-only resolver that mirrors the gateway's active-guardian-channel query.
 *
 * Production resolves the guardian binding + per-channel delivery endpoints from
 * the gateway (`gateway/src/risk/guardian-delivery-resolver.ts`, reached via the
 * `resolve_guardian_delivery` IPC route) — `role = 'guardian'` joined to active
 * gateway contact channels, ordered by verification recency. Tests seed that
 * gateway state via {@link seedContactChannel} / `createGuardianBinding` into the
 * in-process gateway ACL store ({@link liveGatewayAclRows}); this resolver reads
 * the SAME store so the gateway-derived delivery list reflects the seeded
 * binding. No assistant ACL columns are read here — those are Phase-B-dropped.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";

import { liveGatewayAclRows } from "./gateway-acl-store.js";

/**
 * Resolve active guardian deliveries from the gateway ACL store, optionally
 * filtered to a single channel (when `channelType` is given) or to a set of
 * channel types (when `channelTypes` is given). Mirrors the gateway resolution:
 * `role = 'guardian'` joined to active channels, ordered by verification
 * recency.
 */
export function deriveGuardianDeliveries(filter?: {
  channelType?: string;
  channelTypes?: string[];
}): GuardianDelivery[] {
  const rows = liveGatewayAclRows()
    .filter((r) => r.role === "guardian" && r.status === "active")
    .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0));

  if (rows.length === 0) return [];

  // One active guardian per channel type (most-recently-verified wins, since
  // rows are ordered by verifiedAt desc), matching the gateway resolution.
  const byChannel = new Map<string, GuardianDelivery>();
  for (const r of rows) {
    if (byChannel.has(r.channelType)) continue;
    byChannel.set(r.channelType, {
      channelType: r.channelType,
      contactId: r.contactId,
      principalId: r.principalId ?? null,
      displayName: r.displayName ?? null,
      address: r.address,
      externalChatId: r.externalChatId ?? null,
      status: "active",
      verifiedAt: r.verifiedAt ?? null,
    });
  }
  const list = [...byChannel.values()];

  const channelTypes =
    filter?.channelTypes ??
    (filter?.channelType ? [filter.channelType] : undefined);
  return channelTypes
    ? list.filter((g) => channelTypes.includes(g.channelType))
    : list;
}

/**
 * The single active guardian delivery for a channel type, mirroring the
 * gateway's per-channel resolution.
 */
export function deriveGuardianForChannel(
  channelType: string,
): GuardianDelivery | null {
  return deriveGuardianDeliveries({ channelType })[0] ?? null;
}
