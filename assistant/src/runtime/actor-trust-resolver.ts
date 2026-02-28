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
 *
 * The legacy `ActorRole` enum (`guardian` / `non-guardian` / `unverified_channel`)
 * is still required by existing policy gates. The `toLegacyActorRole()` mapper
 * converts the new trust classification to the legacy enum.
 */

import type { ChannelId } from '../channels/types.js';
import type { IngressMember } from '../memory/ingress-member-store.js';
import { findMember } from '../memory/ingress-member-store.js';
import { canonicalizeInboundIdentity } from '../util/canonicalize-identity.js';
import { normalizeAssistantId } from '../util/platform.js';
import { getGuardianBinding } from './channel-guardian-service.js';
import type { ActorRole, DenialReason, GuardianContext } from './guardian-context-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustClass = 'guardian' | 'trusted_contact' | 'unknown';

export interface ActorTrustContext {
  /** Canonical (normalized) sender identity. Null when identity could not be established. */
  canonicalSenderId: string | null;
  /** Guardian binding match, if any, for this (assistantId, channel). */
  guardianBindingMatch: {
    guardianExternalUserId: string;
    guardianDeliveryChatId: string | null;
  } | null;
  /** Ingress member record, if any, for this sender. */
  memberRecord: IngressMember | null;
  /** Trust classification. */
  trustClass: TrustClass;
  /** Assistant-facing metadata for downstream consumption. */
  actorMetadata: {
    identifier: string | undefined;
    displayName: string | undefined;
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
  externalChatId: string;
  senderExternalUserId?: string;
  senderUsername?: string;
  senderDisplayName?: string;
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
  const assistantId = normalizeAssistantId(input.assistantId);

  const rawUserId = typeof input.senderExternalUserId === 'string' && input.senderExternalUserId.trim().length > 0
    ? input.senderExternalUserId.trim()
    : undefined;

  const senderUsername = typeof input.senderUsername === 'string' && input.senderUsername.trim().length > 0
    ? input.senderUsername.trim()
    : undefined;

  const senderDisplayName = typeof input.senderDisplayName === 'string' && input.senderDisplayName.trim().length > 0
    ? input.senderDisplayName.trim()
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
      memberRecord: null,
      trustClass: 'unknown',
      actorMetadata: {
        identifier,
        displayName: senderDisplayName,
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
    externalChatId: input.externalChatId,
  });

  // Trust classification
  let trustClass: TrustClass;
  if (isGuardian) {
    trustClass = 'guardian';
  } else if (memberRecord && memberRecord.status === 'active') {
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
    memberRecord,
    trustClass,
    actorMetadata: {
      identifier,
      displayName: senderDisplayName,
      username: senderUsername,
      channel: input.sourceChannel,
      trustStatus: trustClass,
    },
    denialReason,
  };
}

// ---------------------------------------------------------------------------
// Legacy compatibility mapper
// ---------------------------------------------------------------------------

/**
 * Map the new trust classification to the legacy ActorRole enum used by
 * existing policy gates. This preserves backward compatibility while the
 * codebase migrates to the unified trust model.
 *
 * Mapping:
 * - guardian => 'guardian'
 * - trusted_contact => 'non-guardian' (existing gates treat active members as non-guardian)
 * - unknown (no_identity) => 'unverified_channel'
 * - unknown (no_binding) => 'unverified_channel'
 * - unknown (with binding, not guardian) => 'non-guardian'
 */
export function toLegacyActorRole(ctx: ActorTrustContext): ActorRole {
  if (ctx.trustClass === 'guardian') return 'guardian';
  if (ctx.trustClass === 'trusted_contact') return 'non-guardian';

  // unknown: distinguish between unverified_channel and non-guardian
  if (ctx.denialReason === 'no_identity' || ctx.denialReason === 'no_binding') {
    return 'unverified_channel';
  }

  // Has a binding, has identity, but not guardian and not a member => non-guardian
  if (ctx.guardianBindingMatch && ctx.canonicalSenderId) {
    return 'non-guardian';
  }

  return 'unverified_channel';
}

/**
 * Convert an ActorTrustContext into the legacy GuardianContext shape that
 * existing route-level code expects. This is a bridge for incremental
 * migration — new code should consume ActorTrustContext directly.
 */
export function toGuardianContextCompat(ctx: ActorTrustContext, externalChatId: string): GuardianContext {
  const actorRole = toLegacyActorRole(ctx);

  return {
    actorRole,
    guardianChatId: ctx.guardianBindingMatch?.guardianDeliveryChatId ??
      (actorRole === 'guardian' ? externalChatId : undefined),
    guardianExternalUserId: ctx.guardianBindingMatch?.guardianExternalUserId,
    requesterIdentifier: ctx.actorMetadata.identifier,
    requesterExternalUserId: ctx.canonicalSenderId ?? undefined,
    requesterChatId: externalChatId,
    denialReason: ctx.denialReason,
  };
}
