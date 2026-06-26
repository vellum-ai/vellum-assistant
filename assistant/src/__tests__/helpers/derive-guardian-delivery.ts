/**
 * Test-only resolver that mirrors the gateway's active-guardian-channel query.
 *
 * Production resolves the guardian binding + per-channel delivery endpoints from
 * the gateway (the `resolve_guardian_delivery` IPC route). Tests seed the
 * guardian state via {@link seedContactChannel} / `createGuardianBinding` and
 * back the gateway reader with this resolver so the gateway-derived delivery
 * list reflects the seeded binding. The ACL-column reads are confined here so
 * the trust/guardian test files don't reference the assistant ACL columns
 * directly.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../memory/db-connection.js";
import { contactChannels, contacts } from "../../memory/schema.js";

/**
 * Resolve active guardian deliveries from the local contacts DB, optionally
 * filtered to a single channel (when `channelType` is given) or to a set of
 * channel types (when `channelTypes` is given). Mirrors the gateway resolution:
 * `contacts.role = 'guardian'` joined to active contact channels, ordered by
 * verification recency.
 */
export function deriveGuardianDeliveries(filter?: {
  channelType?: string;
  channelTypes?: string[];
}): GuardianDelivery[] {
  const rows = getDb()
    .select({ contact: contacts, channel: contactChannels })
    .from(contacts)
    .innerJoin(contactChannels, eq(contacts.id, contactChannels.contactId))
    .where(
      and(eq(contacts.role, "guardian"), eq(contactChannels.status, "active")),
    )
    .orderBy(desc(contactChannels.verifiedAt))
    .all();

  if (rows.length === 0) return [];

  // One active guardian per channel type (most-recently-verified wins, since
  // rows are ordered by verifiedAt desc), matching the gateway resolution.
  const byChannel = new Map<string, GuardianDelivery>();
  for (const r of rows) {
    if (byChannel.has(r.channel.type)) continue;
    byChannel.set(r.channel.type, {
      channelType: r.channel.type,
      contactId: r.contact.id,
      principalId: r.contact.principalId ?? null,
      displayName: r.contact.displayName ?? null,
      address: r.channel.address,
      externalChatId: r.channel.externalChatId ?? null,
      status: "active",
      verifiedAt: r.channel.verifiedAt ?? null,
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
