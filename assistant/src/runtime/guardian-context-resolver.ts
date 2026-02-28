/**
 * Shared guardian actor-role resolution for inbound channels.
 *
 * This module centralizes how we classify an inbound actor as
 * guardian/non-guardian/unverified so every channel path uses the same
 * source-of-truth logic.
 *
 * Guardian binding comparisons now use canonicalized identities (E.164 for
 * phone-like channels) to eliminate formatting-variance mismatches.
 */
import type { ChannelId } from '../channels/types.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { canonicalizeInboundIdentity } from '../util/canonicalize-identity.js';
import { normalizeAssistantId } from '../util/platform.js';
import { getGuardianBinding } from './channel-guardian-service.js';

/** Sub-reason for unverified-channel denials. */
export type DenialReason = 'no_binding' | 'no_identity';
export type ActorRole = 'guardian' | 'non-guardian' | 'unverified_channel';

/** Guardian actor context used by route-level approval logic. */
export interface GuardianContext {
  actorRole: ActorRole;
  guardianChatId?: string;
  guardianExternalUserId?: string;
  requesterIdentifier?: string;
  requesterExternalUserId?: string;
  requesterChatId?: string;
  denialReason?: DenialReason;
}

export interface ResolveGuardianContextInput {
  assistantId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  senderExternalUserId?: string;
  senderUsername?: string;
}

/**
 * Resolve guardian actor role from canonical binding state + sender identity.
 *
 * Behavior:
 * - sender matches active binding -> guardian
 * - active binding exists but sender differs -> non-guardian
 * - no sender identity -> unverified_channel (no_identity)
 * - no binding -> unverified_channel (no_binding)
 *
 * Identity comparison is normalization-safe: both the sender ID and the
 * guardian binding ID are canonicalized for the source channel before
 * comparison, so formatting differences (e.g. `+1 (555) 123-4567` vs
 * `+15551234567`) do not cause false non-guardian classifications.
 */
export function resolveGuardianContext(input: ResolveGuardianContextInput): GuardianContext {
  const assistantId = normalizeAssistantId(input.assistantId);
  const rawUserId = typeof input.senderExternalUserId === 'string' && input.senderExternalUserId.trim().length > 0
    ? input.senderExternalUserId.trim()
    : undefined;
  const senderUsername = typeof input.senderUsername === 'string' && input.senderUsername.trim().length > 0
    ? input.senderUsername.trim()
    : undefined;

  // Canonicalize sender identity for normalization-safe comparisons.
  // canonicalizeInboundIdentity returns string | null; coerce to
  // string | undefined so assignments to optional (string | undefined)
  // fields in GuardianContext don't produce a type mismatch.
  const canonicalSenderId = rawUserId
    ? (canonicalizeInboundIdentity(input.sourceChannel, rawUserId) ?? undefined)
    : undefined;

  const requesterIdentifier = senderUsername ? `@${senderUsername}` : canonicalSenderId;

  if (!canonicalSenderId) {
    return {
      actorRole: 'unverified_channel',
      denialReason: 'no_identity',
      requesterIdentifier,
      requesterExternalUserId: undefined,
      requesterChatId: input.externalChatId,
    };
  }

  const binding = getGuardianBinding(assistantId, input.sourceChannel);
  if (!binding) {
    return {
      actorRole: 'unverified_channel',
      denialReason: 'no_binding',
      requesterIdentifier,
      requesterExternalUserId: canonicalSenderId,
      requesterChatId: input.externalChatId,
    };
  }

  // Canonicalize the stored guardian identity for the same channel so
  // phone-format variance in the binding record doesn't cause mismatches.
  const canonicalGuardianId = canonicalizeInboundIdentity(
    input.sourceChannel,
    binding.guardianExternalUserId,
  ) ?? undefined;

  if (canonicalGuardianId === canonicalSenderId) {
    return {
      actorRole: 'guardian',
      guardianChatId: binding.guardianDeliveryChatId || input.externalChatId,
      guardianExternalUserId: binding.guardianExternalUserId,
      requesterIdentifier,
      requesterExternalUserId: canonicalSenderId,
      requesterChatId: input.externalChatId,
    };
  }

  return {
    actorRole: 'non-guardian',
    guardianChatId: binding.guardianDeliveryChatId,
    guardianExternalUserId: binding.guardianExternalUserId,
    requesterIdentifier,
    requesterExternalUserId: canonicalSenderId,
    requesterChatId: input.externalChatId,
  };
}

export function toGuardianRuntimeContext(sourceChannel: ChannelId, ctx: GuardianContext): GuardianRuntimeContext {
  return {
    sourceChannel,
    actorRole: ctx.actorRole,
    guardianChatId: ctx.guardianChatId,
    guardianExternalUserId: ctx.guardianExternalUserId,
    requesterIdentifier: ctx.requesterIdentifier,
    requesterExternalUserId: ctx.requesterExternalUserId,
    requesterChatId: ctx.requesterChatId,
    denialReason: ctx.denialReason,
  };
}
