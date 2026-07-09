/**
 * Gateway-side per-actor trust verdict resolver — the canonical `TrustClass`
 * classifier. The daemon consumes the stamped verdict
 * (`assistant/src/runtime/trust-verdict-consumer.ts`); its residual sync view
 * (`actor-trust-resolver.ts`) classifies guardian-or-unknown only.
 *
 * Reads ONLY the gateway DB (ACL tables + verification session presence) to
 * produce a {@link TrustVerdict} for an inbound actor, resolving channels
 * by `(type,address)` COLLATE NOCASE. Read-only — no writes, no assistant DB,
 * no IPC.
 *
 * Blocked/revoked member channels classify as `unknown`, while their raw
 * `status`/`policy` are surfaced verbatim so the consumer enforces the
 * member_blocked / member_revoked hard-deny.
 */

import type { TrustClass, TrustVerdict } from "@vellumai/gateway-client";
import { and, desc, eq, sql } from "drizzle-orm";

import { guardianIntegrityState } from "../auth/guardian-integrity.js";
import { getGatewayDb } from "../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../db/schema.js";
import { hasInterceptableSession } from "../db/session-store.js";
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
 * a sender whose member row on THIS channel belongs to the guardian contact
 * is classified `guardian` even without a same-channel guardian binding
 * (e.g. the row is pending/unverified), provided that contact still holds an
 * ACTIVE channel. Identity is proven only by the same-channel member row —
 * external identifiers are channel-local namespaces, so a sender with no
 * member row on this channel is a stranger regardless of address collisions
 * with guardian channels on other channel types. A blocked/revoked
 * same-channel row always wins (stays `unknown`), a guardian contact with no
 * active channel anywhere never re-acquires the class, and a matched
 * guardian identity whose contact has NO principal is unresolved — it yields
 * a `resolutionFailed` verdict (consumer soft-denies, no stranger-lane side
 * effects) rather than `guardian` or `unknown`.
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
          interactionCount: gwContactChannels.interactionCount,
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
  // channel where their row is not the active guardian binding (e.g. a
  // pending/unverified row). When the sender's member row on THIS channel
  // belongs to the guardian contact and that contact still holds an ACTIVE
  // channel, classify `guardian`. Requiring an active channel means a fully
  // revoked guardian never re-acquires the class. Identity is proven ONLY by
  // the same-channel member row: external identifiers are channel-local
  // namespaces, so a raw address match against guardian channels of OTHER
  // channel types is not an identity proof — a sender with no member row on
  // this channel stays in the stranger lane no matter what their address
  // equals elsewhere.
  const guardianIdentityFilter =
    memberRow && memberRow.memberRole === "guardian"
      ? eq(gwContacts.id, memberRow.contactId)
      : null;

  const guardianIdentityMatch =
    !isGuardian && !memberDeniedByStatus && guardianIdentityFilter
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

  // Guardian-by-principal requires a principal: without one there is nothing
  // to authorize decisions against, and `guardian` class alone confers
  // self-approving capabilities. A sender who maps to a guardian contact
  // whose principal is NULL (pre-cutover row) is UNRESOLVED — fail safe, not
  // fail-stranger: surface a could-not-vouch verdict so the consumer
  // soft-denies with no stranger-lane side effects. The durable fix is the
  // principal backfill / vellum re-link, not classification.
  if (guardianIdentityMatch && !guardianIdentityMatch.principalId) {
    return { trustClass: "unknown", canonicalSenderId, resolutionFailed: true };
  }
  const guardianByPrincipal = guardianIdentityMatch;

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

  // A gateway DB that has lost its guardian rows (but shows evidence of prior
  // onboarding) misclassifies every sender as a plain stranger. Evaluate the
  // integrity state (TTL-cached) on EVERY resolve so detection/reporting is
  // traffic-independent — intact contact rows classify members normally and
  // would otherwise keep the fail-loud reporter silent until a stranger
  // messages. Only `unknown` classifications get the `resolutionFailed` stamp
  // (consumers fail closed with no stranger-lane side effects); member
  // admission is unchanged. Best-effort: a thrown integrity check degrades to
  // the plain verdict rather than breaking resolution.
  try {
    if (
      guardianIntegrityState() === "missing_guardian" &&
      trustClass === "unknown"
    ) {
      verdict.resolutionFailed = true;
    }
  } catch {
    // Plain verdict; integrity detection must never break resolution.
  }

  // Session-presence stamp (channel-scoped): lets the daemon's deny branches
  // skip their verification-read IPC pair when no session exists. Best-effort
  // — an omitted stamp just falls back to those reads, so a store failure
  // must not convert an otherwise-good verdict into a resolver failure.
  try {
    verdict.hasInterceptableVerificationSession =
      hasInterceptableSession(input.channelType);
  } catch {
    // Stamp omitted; consumer falls back to IPC reads.
  }

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
    verdict.interactionCount = memberRow.interactionCount;
    verdict.memberDisplayName = memberRow.memberDisplayName;
  }

  return verdict;
}
