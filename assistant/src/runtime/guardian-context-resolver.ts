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
  /** Canonical principal ID from the guardian binding. Nullable for backward compatibility — M5 will make this required. */
  guardianPrincipalId?: string | null;
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
    guardianPrincipalId: trust.guardianPrincipalId,
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

// ---------------------------------------------------------------------------
// Routing-state helper
// ---------------------------------------------------------------------------

/**
 * Routing state for a channel actor turn.
 *
 * Determines whether a turn should be treated as interactive (the caller
 * can be kept waiting for a guardian to respond to an approval prompt) by
 * combining trust class with guardian route resolvability.
 *
 * A guardian route is "resolvable" when a verified guardian binding exists
 * for the channel — meaning there is a concrete destination to deliver
 * approval notifications to. Without a resolvable guardian route, entering
 * an interactive wait (up to 300s) is a dead-end: no guardian will ever
 * see the prompt.
 */
export interface RoutingState {
  /** Whether the actor's trust class alone permits interactive waits. */
  canBeInteractive: boolean;
  /** Whether a verified guardian destination exists for this channel. */
  guardianRouteResolvable: boolean;
  /**
   * Whether the turn should actually enter an interactive prompt wait.
   * True only when the actor can be interactive AND a guardian route is
   * resolvable. This is the canonical decision used by processMessage.
   */
  promptWaitingAllowed: boolean;
}

/**
 * Compute the routing state for a channel actor turn.
 *
 * Guardian actors are always interactive (they self-approve).
 * Trusted contacts are only interactive when a guardian binding exists
 * to receive approval notifications. Unknown actors are never interactive.
 */
export function resolveRoutingState(ctx: GuardianContext): RoutingState {
  const isGuardian = ctx.trustClass === 'guardian';
  const isTrustedContact = ctx.trustClass === 'trusted_contact';

  // Guardians self-approve — they are always interactive and route-resolvable.
  if (isGuardian) {
    return {
      canBeInteractive: true,
      guardianRouteResolvable: true,
      promptWaitingAllowed: true,
    };
  }

  // Trusted contacts can be interactive only if a guardian destination
  // exists. The guardian binding populates guardianExternalUserId during
  // trust resolution; its presence means there is a verified guardian
  // to route approval notifications to.
  const guardianRouteResolvable = !!ctx.guardianExternalUserId;
  if (isTrustedContact) {
    return {
      canBeInteractive: true,
      guardianRouteResolvable,
      promptWaitingAllowed: guardianRouteResolvable,
    };
  }

  // Unknown actors are never interactive.
  return {
    canBeInteractive: false,
    guardianRouteResolvable: !!ctx.guardianExternalUserId,
    promptWaitingAllowed: false,
  };
}

/**
 * Convenience: compute routing state from a GuardianRuntimeContext
 * (the shape persisted in stored payloads and used by the retry sweep).
 */
export function resolveRoutingStateFromRuntime(ctx: GuardianRuntimeContext): RoutingState {
  return resolveRoutingState({
    trustClass: ctx.trustClass,
    guardianExternalUserId: ctx.guardianExternalUserId,
  });
}

export function toGuardianRuntimeContext(sourceChannel: ChannelId, ctx: GuardianContext): GuardianRuntimeContext {
  return {
    sourceChannel,
    trustClass: ctx.trustClass,
    guardianChatId: ctx.guardianChatId,
    guardianExternalUserId: ctx.guardianExternalUserId,
    guardianPrincipalId: ctx.guardianPrincipalId,
    requesterIdentifier: ctx.requesterIdentifier,
    requesterDisplayName: ctx.requesterDisplayName,
    requesterSenderDisplayName: ctx.requesterSenderDisplayName,
    requesterMemberDisplayName: ctx.requesterMemberDisplayName,
    requesterExternalUserId: ctx.requesterExternalUserId,
    requesterChatId: ctx.requesterChatId,
    denialReason: ctx.denialReason,
  };
}
