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
 * - `unknown`: sender has no matching contact or no identity could be established.
 */

import type { ChannelId } from "../channels/types.js";
import {
  findContactByChannelExternalId,
  findGuardianForChannel,
} from "../contacts/contact-store.js";
import type { ContactChannel, ContactWithChannels } from "../contacts/types.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("actor-trust-resolver");

export type { TrustContext } from "../daemon/conversation-runtime-assembly.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an inbound actor.
 *
 * - `'guardian'`: The sender matches the active guardian binding for this
 *   (assistant, channel). Guardians have full control-plane access and
 *   self-approve tool invocations.
 * - `'trusted_contact'`: The sender is an active contact with a channel
 *   (not the guardian). Trusted contacts can invoke tools but require
 *   guardian approval for sensitive operations.
 * - `'unknown'`: The sender has no contact record, no identity could be
 *   established, or the sender is an inactive/revoked contact. Unknown
 *   actors are fail-closed with no escalation path.
 */
export type TrustClass = "guardian" | "trusted_contact" | "unknown";

/** Returns `true` for actors that are not fully trusted (i.e. not the guardian). */
export function isUntrustedTrustClass(
  trustClass: TrustClass | undefined,
): boolean {
  return trustClass === "trusted_contact" || trustClass === "unknown";
}

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
  /** Resolved contact + channel for this sender, if any. */
  memberRecord: {
    contact: ContactWithChannels;
    channel: ContactChannel;
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
  const guardianResult = findGuardianForChannel(input.sourceChannel);
  let guardianBindingMatch: ActorTrustContext["guardianBindingMatch"] = null;
  let guardianPrincipalId: string | undefined;
  let isGuardian = false;

  if (guardianResult) {
    const { contact: guardianContact, channel: guardianChannel } =
      guardianResult;
    const canonicalGuardianId = guardianChannel.externalUserId
      ? canonicalizeInboundIdentity(
          input.sourceChannel,
          guardianChannel.externalUserId,
        )
      : null;
    guardianBindingMatch = {
      guardianExternalUserId: guardianChannel.externalUserId ?? "",
      guardianDeliveryChatId: guardianChannel.externalChatId,
    };
    guardianPrincipalId = guardianContact.principalId ?? undefined;
    isGuardian =
      canonicalGuardianId != null && canonicalGuardianId === canonicalSenderId;
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
  const contactMatch = findContactByChannelExternalId(
    input.sourceChannel,
    canonicalSenderId,
  );
  if (contactMatch) {
    const matchingChannel = contactMatch.channels.find(
      (ch) =>
        ch.type === input.sourceChannel &&
        ch.externalUserId === canonicalSenderId,
    );
    if (matchingChannel) {
      memberRecord = { contact: contactMatch, channel: matchingChannel };
    }
  }
  log.debug(
    {
      channel: input.sourceChannel,
      canonicalSenderId,
      found: !!memberRecord,
    },
    "trust-resolver member lookup",
  );

  // Only use member metadata when the record's externalUserId matches the
  // current sender to avoid misidentification in group chats.
  // Canonicalize the stored member ID to handle formatting variance (e.g.
  // phone numbers stored without E.164 normalization).
  const memberMatchesSender = memberRecord?.channel.externalUserId
    ? canonicalizeInboundIdentity(
        input.sourceChannel,
        memberRecord.channel.externalUserId,
      ) === canonicalSenderId
    : false;

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
  } else if (
    memberMatchesSender &&
    memberRecord &&
    memberRecord.channel.status === "active"
  ) {
    trustClass = "trusted_contact";
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
  };
}
