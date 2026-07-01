/**
 * Gateway-side per-actor trust verdict resolver.
 *
 * Reads ONLY the gateway ACL DB to produce a {@link TrustVerdict} for an
 * inbound actor. Mirrors the daemon's classification precedence
 * (`actor-trust-resolver.ts`) and resolves channels by `(type,address)`
 * COLLATE NOCASE. Read-only — no writes, no assistant DB, no IPC.
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
import { canonicalSenderIdFor } from "../verification/identity.js";

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
 *
 * Guardian classification is by principal, not only by same-channel binding:
 * a sender whose identity maps to the guardian contact (via this channel's
 * member row, or via an active guardian channel on any channel type) is
 * classified `guardian` even without a same-channel guardian binding. A
 * blocked/revoked same-channel row always wins (stays `unknown`), and a
 * guardian contact with no active channel anywhere never re-acquires the
 * class.
 */
export async function resolveTrustVerdict(
  input: ResolveTrustVerdictInput,
): Promise<TrustVerdict> {
  const db = getGatewayDb();

  const canonicalSenderId = canonicalSenderIdFor(
    input.channelType,
    input.actorExternalId,
  );

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
          memberRole: gwContacts.role,
          memberPrincipalId: gwContacts.principalId,
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

  // A blocked/revoked same-channel row is an explicit per-channel governance
  // action and always wins: it suppresses the principal-level guardian check
  // below and classifies `unknown` (raw status/policy still surfaced so the
  // consumer enforces the member_blocked / member_revoked hard-deny).
  const memberDeniedByStatus =
    !!memberRow &&
    memberRow.status !== "active" &&
    memberRow.status !== "pending" &&
    memberRow.status !== "unverified";

  // --- Guardian-by-principal (sender maps to the guardian contact) ---
  // The same-channel address match above fails for a guardian speaking on a
  // channel where they hold no active guardian binding. Never route the
  // guardian through the stranger lane: when the sender's identity maps to
  // the guardian contact — via this channel's member row, or (with no member
  // row) via the sender's address on any channel type — and that contact
  // still holds an ACTIVE channel, classify `guardian`. Requiring an active
  // channel means a fully revoked guardian never re-acquires the class. A
  // non-guardian member row wins over any cross-channel address collision,
  // so no identity filter is built for it.
  const guardianIdentityFilter = memberRow
    ? memberRow.memberRole === "guardian"
      ? eq(gwContacts.id, memberRow.contactId)
      : null
    : sql`${gwContactChannels.address} = ${canonicalSenderId} COLLATE NOCASE`;

  const guardianByPrincipal =
    !isGuardian &&
    canonicalSenderId &&
    !memberDeniedByStatus &&
    guardianIdentityFilter
      ? (db
          .select({
            principalId: gwContacts.principalId,
            displayName: gwContacts.displayName,
          })
          .from(gwContactChannels)
          .innerJoin(gwContacts, eq(gwContactChannels.contactId, gwContacts.id))
          .where(
            and(
              eq(gwContacts.role, "guardian"),
              eq(gwContactChannels.status, "active"),
              guardianIdentityFilter,
            ),
          )
          .limit(1)
          .get() ?? null)
      : null;

  let trustClass: TrustClass;
  if (isGuardian || guardianByPrincipal) {
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
  } else if (guardianByPrincipal) {
    // Principal-classified guardian with no same-channel binding: carry the
    // principal + label so the consumer can authorize decisions by principal.
    // Delivery fields (address/chat id) stay absent — they describe the
    // same-channel binding, which does not exist here.
    if (guardianByPrincipal.principalId) {
      verdict.guardianPrincipalId = guardianByPrincipal.principalId;
    }
    if (guardianByPrincipal.displayName) {
      verdict.guardianDisplayName = guardianByPrincipal.displayName;
    }
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
