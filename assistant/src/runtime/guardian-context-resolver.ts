/**
 * Shared guardian actor-role resolution for inbound channels.
 *
 * This module centralizes how we classify an inbound actor as
 * guardian/non-guardian/unverified so every channel path uses the same
 * source-of-truth logic.
 */
import type { ChannelId } from '../channels/types.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
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
 */
export function resolveGuardianContext(input: ResolveGuardianContextInput): GuardianContext {
  const assistantId = normalizeAssistantId(input.assistantId);
  const senderExternalUserId = typeof input.senderExternalUserId === 'string' && input.senderExternalUserId.trim().length > 0
    ? input.senderExternalUserId.trim()
    : undefined;
  const senderUsername = typeof input.senderUsername === 'string' && input.senderUsername.trim().length > 0
    ? input.senderUsername.trim()
    : undefined;
  const requesterIdentifier = senderUsername ? `@${senderUsername}` : senderExternalUserId;

  if (!senderExternalUserId) {
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
      requesterExternalUserId: senderExternalUserId,
      requesterChatId: input.externalChatId,
    };
  }

  if (binding.guardianExternalUserId === senderExternalUserId) {
    return {
      actorRole: 'guardian',
      guardianChatId: binding.guardianDeliveryChatId || input.externalChatId,
      guardianExternalUserId: binding.guardianExternalUserId,
      requesterIdentifier,
      requesterExternalUserId: senderExternalUserId,
      requesterChatId: input.externalChatId,
    };
  }

  return {
    actorRole: 'non-guardian',
    guardianChatId: binding.guardianDeliveryChatId,
    guardianExternalUserId: binding.guardianExternalUserId,
    requesterIdentifier,
    requesterExternalUserId: senderExternalUserId,
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
