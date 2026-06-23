/**
 * Gateway-side per-actor trust verdict resolver.
 *
 * Reads ONLY the gateway ACL DB to produce a {@link TrustVerdict} for an
 * inbound actor. Mirrors the daemon's classification precedence
 * (`actor-trust-resolver.ts`) and the Combo-7 `(type,address)` COLLATE NOCASE
 * read pattern. Read-only — no writes, no assistant DB, no IPC.
 *
 * Blocked/revoked member channels classify as `unknown` (mirroring the
 * daemon), while their raw `status`/`policy` are surfaced verbatim so the
 * consumer enforces the member_blocked / member_revoked hard-deny.
 */

import type { TrustClass, TrustVerdict } from "@vellumai/gateway-client";
import { and, desc, eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";

export interface ResolveTrustVerdictInput {
  channelType: string;
  actorExternalId?: string;
}

/**
 * Resolve the per-actor trust verdict from the gateway ACL DB.
 *
 * 1. Canonicalize `actorExternalId` for this channel (E.164 for phone-like).
 * 2. Resolve the channel's active guardian binding (label/identity fields).
 * 3. Resolve THIS actor's member channel by `(type,address)` COLLATE NOCASE.
 * 4. Classify guardian > trusted_contact > unverified_contact > unknown.
 */
export async function resolveTrustVerdict(
  input: ResolveTrustVerdictInput,
): Promise<TrustVerdict> {
  const db = getGatewayDb();

  const rawActorId =
    typeof input.actorExternalId === "string" &&
    input.actorExternalId.trim().length > 0
      ? input.actorExternalId.trim()
      : undefined;

  const canonicalSenderId = rawActorId
    ? canonicalizeInboundIdentity(input.channelType, rawActorId)
    : null;

  // --- Guardian-for-channel binding (independent of THIS actor) ---
  const guardianRow = db
    .select({
      address: gwContactChannels.address,
      externalChatId: gwContactChannels.externalChatId,
      principalId: gwContacts.principalId,
      displayName: gwContacts.displayName,
    })
    .from(gwContacts)
    .innerJoin(
      gwContactChannels,
      eq(gwContactChannels.contactId, gwContacts.id),
    )
    .where(
      and(
        eq(gwContacts.role, "guardian"),
        eq(gwContactChannels.type, input.channelType),
        eq(gwContactChannels.status, "active"),
      ),
    )
    .orderBy(desc(gwContactChannels.verifiedAt))
    .limit(1)
    .get();

  // --- Member channel for THIS actor (address-keyed, COLLATE NOCASE) ---
  const memberRow = canonicalSenderId
    ? db
        .select({
          contactId: gwContactChannels.contactId,
          channelId: gwContactChannels.id,
          type: gwContactChannels.type,
          address: gwContactChannels.address,
          externalChatId: gwContactChannels.externalChatId,
          status: gwContactChannels.status,
          policy: gwContactChannels.policy,
          verifiedAt: gwContactChannels.verifiedAt,
          verifiedVia: gwContactChannels.verifiedVia,
          memberDisplayName: gwContacts.displayName,
        })
        .from(gwContactChannels)
        .innerJoin(gwContacts, eq(gwContactChannels.contactId, gwContacts.id))
        .where(
          and(
            eq(gwContactChannels.type, input.channelType),
            sql`${gwContactChannels.address} = ${canonicalSenderId} COLLATE NOCASE`,
          ),
        )
        .limit(1)
        .get()
    : undefined;

  // --- Classification (mirrors resolveActorTrust precedence) ---
  // The guardian binding is the ACTIVE guardian channel for this channel type
  // (the status='active' filter above excludes revoked/blocked guardian
  // channels). A sender is the guardian only when their canonical id matches
  // that active address — a stale revoked channel never confers guardian.
  const isGuardian =
    !!guardianRow &&
    !!canonicalSenderId &&
    guardianRow.address.toLowerCase() === canonicalSenderId.toLowerCase();

  let trustClass: TrustClass;
  if (isGuardian) {
    trustClass = "guardian";
  } else if (memberRow) {
    const status = memberRow.status;
    if (status === "active") {
      trustClass = "trusted_contact";
    } else if (status === "unverified" || status === "pending") {
      trustClass = "unverified_contact";
    } else {
      // blocked/revoked → unknown, matching the canonical resolver. Raw
      // status/policy are still surfaced below so the consumer enforces the
      // member_blocked / member_revoked hard-deny.
      trustClass = "unknown";
    }
  } else {
    trustClass = "unknown";
  }

  const verdict: TrustVerdict = { trustClass, canonicalSenderId };

  if (guardianRow) {
    verdict.guardianExternalUserId = guardianRow.address;
    verdict.guardianDeliveryChatId = guardianRow.externalChatId;
    if (guardianRow.principalId)
      verdict.guardianPrincipalId = guardianRow.principalId;
    verdict.guardianDisplayName = guardianRow.displayName;
  }

  if (memberRow) {
    verdict.contactId = memberRow.contactId;
    verdict.channelId = memberRow.channelId;
    verdict.type = memberRow.type;
    verdict.address = memberRow.address;
    verdict.externalChatId = memberRow.externalChatId;
    verdict.status = memberRow.status;
    verdict.policy = memberRow.policy;
    verdict.verifiedAt = memberRow.verifiedAt;
    verdict.verifiedVia = memberRow.verifiedVia;
    verdict.memberDisplayName = memberRow.memberDisplayName;
  }

  return verdict;
}
