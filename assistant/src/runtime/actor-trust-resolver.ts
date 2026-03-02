/**
 * Unified inbound actor trust resolver.
 *
 * Produces a single trust-resolved actor context from raw inbound identity
 * fields. Normalizes sender identity via channel-agnostic canonicalization,
 * then resolves trust classification by checking guardian bindings and
 * ingress member records.
 *
 * Trust classifications:
 * - `guardian`: sender matches the active guardian binding for this channel.
 * - `trusted_contact`: sender is an active ingress member (not the guardian).
 * - `unknown`: sender has no member record or no identity could be established.
 */

import type { ChannelId } from '../channels/types.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type { IngressMember } from '../memory/ingress-member-store.js';
import { findMember } from '../memory/ingress-member-store.js';
import { canonicalizeInboundIdentity } from '../util/canonicalize-identity.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from './assistant-scope.js';
import { getGuardianBinding } from './channel-guardian-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustClass = 'guardian' | 'trusted_contact' | 'unknown';
export type DenialReason = 'no_binding' | 'no_identity';

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
  /** Ingress member record, if any, for this sender. */
  memberRecord: IngressMember | null;
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
  /** Legacy denial reason for backward-compatible unverified_channel paths. */
  denialReason?: DenialReason;
}

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
 * 4. Look up the ingress member record using the canonical identity.
 * 5. Classify: guardian > trusted_contact (active member) > unknown.
 */
export function resolveActorTrust(input: ResolveActorTrustInput): ActorTrustContext {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

  const rawUserId = typeof input.actorExternalId === 'string' && input.actorExternalId.trim().length > 0
    ? input.actorExternalId.trim()
    : undefined;

  const senderUsername = typeof input.actorUsername === 'string' && input.actorUsername.trim().length > 0
    ? input.actorUsername.trim()
    : undefined;

  const senderDisplayName = typeof input.actorDisplayName === 'string' && input.actorDisplayName.trim().length > 0
    ? input.actorDisplayName.trim()
    : undefined;

  // Canonical identity: normalize phone-like channels to E.164.
  const canonicalSenderId = rawUserId
    ? canonicalizeInboundIdentity(input.sourceChannel, rawUserId)
    : null;

  const identifier = senderUsername ? `@${senderUsername}` : canonicalSenderId ?? undefined;

  // No identity at all => unknown
  if (!canonicalSenderId) {
    return {
      canonicalSenderId: null,
      guardianBindingMatch: null,
      guardianPrincipalId: undefined,
      memberRecord: null,
      trustClass: 'unknown',
      actorMetadata: {
        identifier,
        displayName: senderDisplayName,
        senderDisplayName,
        memberDisplayName: undefined,
        username: senderUsername,
        channel: input.sourceChannel,
        trustStatus: 'unknown',
      },
      denialReason: 'no_identity',
    };
  }

  // Guardian binding lookup
  const binding = getGuardianBinding(assistantId, input.sourceChannel);
  const guardianBindingMatch = binding
    ? { guardianExternalUserId: binding.guardianExternalUserId, guardianDeliveryChatId: binding.guardianDeliveryChatId }
    : null;

  // Check if sender IS the guardian. Compare canonical sender against the
  // binding's guardian identity (also canonicalize for phone channels to
  // handle formatting variance in the stored binding).
  let isGuardian = false;
  if (binding) {
    const canonicalGuardianId = canonicalizeInboundIdentity(input.sourceChannel, binding.guardianExternalUserId);
    isGuardian = canonicalGuardianId === canonicalSenderId;
  }

  // Ingress member lookup using canonical identity.
  const memberRecord = findMember({
    assistantId,
    sourceChannel: input.sourceChannel,
    externalUserId: canonicalSenderId,
    externalChatId: input.conversationExternalId,
  });

  // In group chats, findMember may match on externalChatId and return a
  // record for a different user. Only use member metadata when the record's
  // externalUserId matches the current sender to avoid misidentification.
  // Canonicalize the stored member ID to handle formatting variance (e.g.
  // phone numbers stored without E.164 normalization).
  const memberMatchesSender = memberRecord?.externalUserId
    ? canonicalizeInboundIdentity(input.sourceChannel, memberRecord.externalUserId) === canonicalSenderId
    : false;

  const memberUsername = memberMatchesSender && typeof memberRecord?.username === 'string' && memberRecord.username.trim().length > 0
    ? memberRecord.username.trim()
    : undefined;
  const memberDisplayName = memberMatchesSender && typeof memberRecord?.displayName === 'string' && memberRecord.displayName.trim().length > 0
    ? memberRecord.displayName.trim()
    : undefined;
  // Prefer member profile metadata over transient sender metadata so guardian-
  // curated contact details are canonical for assistant-facing identity —
  // but only when the member record actually belongs to the current sender.
  const resolvedUsername = memberUsername ?? senderUsername;
  const resolvedDisplayName = memberDisplayName ?? senderDisplayName;
  const resolvedIdentifier = resolvedUsername ? `@${resolvedUsername}` : canonicalSenderId ?? undefined;

  // Trust classification
  let trustClass: TrustClass;
  if (isGuardian) {
    trustClass = 'guardian';
  } else if (memberMatchesSender && memberRecord && memberRecord.status === 'active') {
    trustClass = 'trusted_contact';
  } else {
    trustClass = 'unknown';
  }

  // Denial reason for legacy compatibility
  let denialReason: DenialReason | undefined;
  if (!isGuardian && !binding) {
    denialReason = 'no_binding';
  }

  return {
    canonicalSenderId,
    guardianBindingMatch,
    guardianPrincipalId: binding?.guardianPrincipalId ?? undefined,
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
    denialReason,
  };
}

/**
 * Convert an ActorTrustContext into the runtime trust context shape used by
 * sessions/tooling.
 */
export function toGuardianRuntimeContextFromTrust(
  ctx: ActorTrustContext,
  conversationExternalId: string,
): GuardianRuntimeContext {
  return {
    sourceChannel: ctx.actorMetadata.channel,
    trustClass: ctx.trustClass,
    guardianChatId: ctx.guardianBindingMatch?.guardianDeliveryChatId ??
      (ctx.trustClass === 'guardian' ? conversationExternalId : undefined),
    guardianExternalUserId: ctx.guardianBindingMatch?.guardianExternalUserId,
    guardianPrincipalId: ctx.guardianPrincipalId,
    requesterIdentifier: ctx.actorMetadata.identifier,
    requesterDisplayName: ctx.actorMetadata.displayName,
    requesterSenderDisplayName: ctx.actorMetadata.senderDisplayName,
    requesterMemberDisplayName: ctx.actorMetadata.memberDisplayName,
    requesterExternalUserId: ctx.canonicalSenderId ?? undefined,
    requesterChatId: conversationExternalId,
    denialReason: ctx.denialReason,
  };
}
