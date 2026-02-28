/**
 * Shared inbound trust resolution for channel actors.
 *
 * This module provides a compact route-level shape used by channel routes
 * while delegating canonical classification to the unified actor trust
 * resolver.
 */
import type { ChannelId } from '../channels/types.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { canonicalizeInboundIdentity } from '../util/canonicalize-identity.js';
import {
  type DenialReason,
  resolveActorTrust,
  type ResolveActorTrustInput,
  type TrustClass,
} from './actor-trust-resolver.js';
export type { DenialReason } from './actor-trust-resolver.js';

/** Trust classification used by route-level channel logic. */
export type ActorTrustClass = TrustClass;

/** Guardian actor context used by route-level approval logic. */
export interface GuardianContext {
  trustClass: ActorTrustClass;
  guardianChatId?: string;
  guardianExternalUserId?: string;
  requesterIdentifier?: string;
  requesterDisplayName?: string;
  requesterSenderDisplayName?: string;
  requesterMemberDisplayName?: string;
  requesterExternalUserId?: string;
  requesterChatId?: string;
  memberStatus?: string;
  memberPolicy?: string;
  denialReason?: DenialReason;
}

export type ResolveGuardianContextInput = ResolveActorTrustInput;

/**
 * Resolve route-level trust context from canonical identity state.
 */
export function resolveGuardianContext(input: ResolveGuardianContextInput): GuardianContext {
  const trust = resolveActorTrust(input);
  const canonicalGuardianExternalUserId = trust.guardianBindingMatch?.guardianExternalUserId
    ? canonicalizeInboundIdentity(input.sourceChannel, trust.guardianBindingMatch.guardianExternalUserId) ?? undefined
    : undefined;
  return {
    trustClass: trust.trustClass,
    guardianChatId: trust.guardianBindingMatch?.guardianDeliveryChatId ??
      (trust.trustClass === 'guardian' ? input.externalChatId : undefined),
    guardianExternalUserId: canonicalGuardianExternalUserId,
    requesterIdentifier: trust.actorMetadata.identifier,
    requesterDisplayName: trust.actorMetadata.displayName,
    requesterSenderDisplayName: trust.actorMetadata.senderDisplayName,
    requesterMemberDisplayName: trust.actorMetadata.memberDisplayName,
    requesterExternalUserId: trust.canonicalSenderId ?? undefined,
    requesterChatId: input.externalChatId,
    memberStatus: trust.memberRecord?.status ?? undefined,
    memberPolicy: trust.memberRecord?.policy ?? undefined,
    denialReason: trust.denialReason,
  };
}

export function toGuardianRuntimeContext(sourceChannel: ChannelId, ctx: GuardianContext): GuardianRuntimeContext {
  return {
    sourceChannel,
    trustClass: ctx.trustClass,
    guardianChatId: ctx.guardianChatId,
    guardianExternalUserId: ctx.guardianExternalUserId,
    requesterIdentifier: ctx.requesterIdentifier,
    requesterDisplayName: ctx.requesterDisplayName,
    requesterSenderDisplayName: ctx.requesterSenderDisplayName,
    requesterMemberDisplayName: ctx.requesterMemberDisplayName,
    requesterExternalUserId: ctx.requesterExternalUserId,
    requesterChatId: ctx.requesterChatId,
    denialReason: ctx.denialReason,
  };
}
