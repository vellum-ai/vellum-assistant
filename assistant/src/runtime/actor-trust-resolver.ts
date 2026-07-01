/**
 * Unified inbound actor trust resolver.
 *
 * Produces a single trust-resolved actor context from raw inbound identity
 * fields. Normalizes sender identity via channel-agnostic canonicalization,
 * then resolves trust classification by checking contacts/contact_channels.
 *
 * Trust classifications:
 * - `guardian`: sender matches the guardian contact's channel for this channel type.
 * - `trusted_contact`: sender is an active contact channel (not the guardian).
 * - `unverified_contact`: sender matches a contact channel that is pending or
 *   unverified — known to the guardian but not yet through verification.
 *   Treated identically to `trusted_contact` downstream; the distinction only
 *   matters at the admission floor (see channel admission policy).
 * - `unknown`: sender has no matching contact, no identity could be
 *   established, or the contact's channel is blocked/revoked.
 */

import type { ChannelId } from "../channels/types.js";
import { findContactByAddress } from "../contacts/contact-store.js";
import {
  guardianForChannel,
  peekCachedGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { channelStatusToMemberStatus } from "../contacts/member-status.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactRole,
  ContactWithChannels,
} from "../contacts/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { getCachedMemberAcl } from "./member-verdict-cache.js";
import type { TrustClass } from "./trust-class.js";

const log = getLogger("actor-trust-resolver");

export type { TrustContext } from "../daemon/trust-context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an inbound actor. Defined once in `./trust-class.ts`
 * (shared with the persistence metadata schema) and re-exported here, the
 * canonical import site for the resolver's consumers.
 */
export type { TrustClass };

/**
 * Fully resolved trust context from the actor trust resolver.
 *
 * This is the intermediate representation between raw inbound identity
 * fields ({@link ResolveActorTrustInput}) and the runtime trust context
 * ({@link TrustContext}). It carries the full resolution state including
 * canonical identity, guardian binding match, member record, and trust
 * classification. Convert to `TrustContext` via {@link toTrustContext}
 * for use in sessions and tooling.
 */
export interface ActorTrustContext {
  /** Canonical (normalized) sender identity. Null when identity could not be established. */
  canonicalSenderId: string | null;
  /** Guardian binding match, if any, for this (assistantId, channel). */
  guardianBindingMatch: {
    guardianExternalUserId: string;
    guardianDeliveryChatId: string | null;
  } | null;
  /** Canonical principal ID from the guardian binding. */
  guardianPrincipalId?: string;
  /**
   * Resolved contact + channel for this sender, if any. The ACL view
   * (status/policy/role) is carried here rather than on the contact/channel
   * objects, sourced from the gateway verdict — the verdict path reads it
   * inline, the sync fallback from the in-memory member-verdict cache.
   */
  memberRecord: {
    contact: ContactWithChannels;
    channel: ContactChannel;
    status: ChannelStatus;
    policy: ChannelPolicy;
    role: ContactRole;
  } | null;
  /** Trust classification. */
  trustClass: TrustClass;
  /** Assistant-facing metadata for downstream consumption. */
  actorMetadata: {
    identifier: string | undefined;
    displayName: string | undefined;
    senderDisplayName: string | undefined;
    memberDisplayName: string | undefined;
    username: string | undefined;
    channel: ChannelId;
    trustStatus: TrustClass;
  };
}

/**
 * Raw identity fields from an inbound channel message, used as input to
 * {@link resolveActorTrust}. These are the channel-agnostic identity
 * signals available at message ingress before any trust resolution.
 */
export interface ResolveActorTrustInput {
  assistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorExternalId?: string;
  actorUsername?: string;
  actorDisplayName?: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the inbound actor's trust context from raw identity fields.
 *
 * 1. Canonicalize the sender identity (E.164 for phone channels, trimmed ID otherwise).
 * 2. Look up the guardian binding for (assistantId, channel).
 * 3. Compare canonical sender identity to the guardian binding.
 * 4. Look up the contact record using the canonical identity.
 * 5. Classify: guardian > trusted_contact (active member) > unknown.
 */
export function resolveActorTrust(
  input: ResolveActorTrustInput,
): ActorTrustContext {
  const rawUserId =
    typeof input.actorExternalId === "string" &&
    input.actorExternalId.trim().length > 0
      ? input.actorExternalId.trim()
      : undefined;

  const senderUsername =
    typeof input.actorUsername === "string" &&
    input.actorUsername.trim().length > 0
      ? input.actorUsername.trim()
      : undefined;

  const senderDisplayName =
    typeof input.actorDisplayName === "string" &&
    input.actorDisplayName.trim().length > 0
      ? input.actorDisplayName.trim()
      : undefined;

  // Canonical identity: normalize phone-like channels to E.164.
  const canonicalSenderId = rawUserId
    ? canonicalizeInboundIdentity(input.sourceChannel, rawUserId)
    : null;

  const identifier = senderUsername
    ? `@${senderUsername}`
    : (canonicalSenderId ?? undefined);

  // No identity at all => unknown
  if (!canonicalSenderId) {
    return {
      canonicalSenderId: null,
      guardianBindingMatch: null,
      guardianPrincipalId: undefined,
      memberRecord: null,
      trustClass: "unknown",
      actorMetadata: {
        identifier,
        displayName: senderDisplayName,
        senderDisplayName,
        memberDisplayName: undefined,
        username: senderUsername,
        channel: input.sourceChannel,
        trustStatus: "unknown",
      },
    };
  }

  // --- Guardian lookup ---
  // Sync read of the gateway guardian delivery from the IO-free cache snapshot
  // (kept warm by the async hot paths + daemon-startup warm). A cold cache
  // yields no guardian match, the same outcome as no binding.
  const cachedGuardians = peekCachedGuardianDelivery({
    channelTypes: [input.sourceChannel],
  });
  const guardianDelivery = cachedGuardians
    ? guardianForChannel(cachedGuardians, input.sourceChannel)
    : undefined;
  let guardianBindingMatch: ActorTrustContext["guardianBindingMatch"] = null;
  let guardianPrincipalId: string | undefined;
  let isGuardian = false;

  if (guardianDelivery) {
    guardianBindingMatch = {
      guardianExternalUserId: guardianDelivery.address,
      guardianDeliveryChatId: guardianDelivery.externalChatId ?? null,
    };
    guardianPrincipalId = guardianDelivery.principalId ?? undefined;
    isGuardian =
      guardianDelivery.address.toLowerCase() ===
      canonicalSenderId.toLowerCase();
  }

  log.debug(
    {
      channel: input.sourceChannel,
      source: "contacts",
      found: !!guardianBindingMatch,
    },
    "trust-resolver guardian lookup",
  );

  // --- Member lookup via contacts ---
  let memberRecord: ActorTrustContext["memberRecord"] = null;
  const byAddress = findContactByAddress(
    input.sourceChannel,
    canonicalSenderId,
  );
  const byAddressChannel = byAddress?.channels.find(
    (ch) =>
      ch.type === input.sourceChannel &&
      ch.address.toLowerCase() === canonicalSenderId.toLowerCase(),
  );
  if (byAddress && byAddressChannel) {
    const acl = getCachedMemberAcl(input.sourceChannel, canonicalSenderId);
    if (acl) {
      memberRecord = { contact: byAddress, channel: byAddressChannel, ...acl };
    }
    // Fail-closed: already in the sync fallback (no live verdict) and no cached
    // verdict → leave memberRecord null so trustClass resolves to unknown.
  }

  log.debug(
    {
      channel: input.sourceChannel,
      canonicalSenderId,
      found: !!memberRecord,
      via: memberRecord ? "address" : "none",
    },
    "trust-resolver member lookup",
  );

  // Only use member metadata when the record's channel identity matches the
  // current sender to avoid misidentification in group chats.
  const memberMatchesSender =
    memberRecord?.channel.address.toLowerCase() ===
    canonicalSenderId.toLowerCase();

  const memberDisplayName =
    memberMatchesSender &&
    typeof memberRecord?.contact.displayName === "string" &&
    memberRecord.contact.displayName.trim().length > 0
      ? memberRecord.contact.displayName.trim()
      : undefined;
  // Prefer member profile metadata over transient sender metadata so guardian-
  // curated contact details are canonical for assistant-facing identity —
  // but only when the member record actually belongs to the current sender.
  const resolvedUsername = senderUsername;
  const resolvedDisplayName = memberDisplayName ?? senderDisplayName;
  const resolvedIdentifier = resolvedUsername
    ? `@${resolvedUsername}`
    : (canonicalSenderId ?? undefined);

  // Trust classification
  let trustClass: TrustClass;
  if (isGuardian) {
    trustClass = "guardian";
  } else if (memberMatchesSender && memberRecord) {
    const status = memberRecord.status;
    if (status === "active") {
      trustClass = "trusted_contact";
    } else if (status === "unverified" || status === "pending") {
      // Pre-verification / awaiting-verification contacts get their own
      // admission tier. Treated identically to trusted_contact for ALL
      // downstream capability/tool/approval decisions; the distinction
      // only matters at the channel admission floor.
      trustClass = "unverified_contact";
    } else {
      // status === "blocked" or "revoked" → unknown. acl-enforcement
      // re-checks resolvedMember.channel.status and emits the appropriate
      // member_blocked / member_revoked reasons, so hard-deny semantics
      // for these statuses are preserved end-to-end.
      trustClass = "unknown";
    }
  } else {
    trustClass = "unknown";
  }

  return {
    canonicalSenderId,
    guardianBindingMatch,
    guardianPrincipalId,
    memberRecord,
    trustClass,
    actorMetadata: {
      identifier: resolvedIdentifier,
      displayName: resolvedDisplayName,
      senderDisplayName,
      memberDisplayName,
      username: resolvedUsername,
      channel: input.sourceChannel,
      trustStatus: trustClass,
    },
  };
}

/**
 * Convert an ActorTrustContext into the runtime TrustContext shape used by
 * sessions/tooling.
 *
 * This is the single canonical conversion from resolved trust to runtime
 * context. The guardianExternalUserId is canonicalized to handle phone-
 * channel formatting variance (e.g. stored binding vs E.164).
 */
export function toTrustContext(
  ctx: ActorTrustContext,
  conversationExternalId: string,
): TrustContext {
  const canonicalGuardianExternalUserId = ctx.guardianBindingMatch
    ?.guardianExternalUserId
    ? (canonicalizeInboundIdentity(
        ctx.actorMetadata.channel,
        ctx.guardianBindingMatch.guardianExternalUserId,
      ) ?? undefined)
    : undefined;
  return {
    sourceChannel: ctx.actorMetadata.channel,
    trustClass: ctx.trustClass,
    guardianChatId:
      ctx.guardianBindingMatch?.guardianDeliveryChatId ??
      (ctx.trustClass === "guardian" ? conversationExternalId : undefined),
    guardianExternalUserId: canonicalGuardianExternalUserId,
    guardianPrincipalId: ctx.guardianPrincipalId,
    requesterIdentifier: ctx.actorMetadata.identifier,
    requesterDisplayName: ctx.actorMetadata.displayName,
    requesterSenderDisplayName: ctx.actorMetadata.senderDisplayName,
    requesterMemberDisplayName: ctx.actorMetadata.memberDisplayName,
    requesterExternalUserId: ctx.canonicalSenderId ?? undefined,
    requesterChatId: conversationExternalId,
    // Member grounding from the resolved memberRecord (voice + verdict paths
    // both populate it).
    requesterContactId: ctx.memberRecord?.contact.id,
    memberStatus: ctx.memberRecord
      ? channelStatusToMemberStatus(ctx.memberRecord.status)
      : undefined,
    memberPolicy: ctx.memberRecord?.policy,
  };
}
