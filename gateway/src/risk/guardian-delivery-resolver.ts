/**
 * Gateway-side guardian binding + delivery resolver.
 *
 * Reads ONLY the gateway ACL DB to return every active guardian channel and
 * its delivery endpoint as a {@link GuardianDelivery}. Mirrors the guardian
 * binding query in `trust-verdict-resolver.ts`, but returns ALL active
 * guardian channels (not LIMIT 1), optionally filtered to `channelTypes`.
 * Read-only — no writes, no assistant DB, no IPC.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";
import { and, desc, eq, inArray } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";

export interface ResolveGuardianDeliveryInput {
  channelTypes?: string[];
}

/**
 * Resolve the active guardian binding(s) + delivery endpoints from the gateway
 * ACL DB, optionally narrowed to `channelTypes`.
 */
export function resolveGuardianDelivery(
  input: ResolveGuardianDeliveryInput,
): GuardianDelivery[] {
  const db = getGatewayDb();

  const filters = [
    eq(gwContacts.role, "guardian"),
    eq(gwContactChannels.status, "active"),
  ];
  if (input.channelTypes && input.channelTypes.length > 0) {
    filters.push(inArray(gwContactChannels.type, input.channelTypes));
  }

  // Projection matches GuardianDelivery exactly.
  return db
    .select({
      channelType: gwContactChannels.type,
      contactId: gwContactChannels.contactId,
      principalId: gwContacts.principalId,
      displayName: gwContacts.displayName,
      address: gwContactChannels.address,
      externalChatId: gwContactChannels.externalChatId,
      status: gwContactChannels.status,
      verifiedAt: gwContactChannels.verifiedAt,
    })
    .from(gwContacts)
    .innerJoin(gwContactChannels, eq(gwContactChannels.contactId, gwContacts.id))
    .where(and(...filters))
    .orderBy(desc(gwContactChannels.verifiedAt))
    .all();
}
