/**
 * Shared inbound trust resolution for channel actors.
 *
 * GuardianContext is a type alias for GuardianRuntimeContext — the
 * canonical runtime trust context used by sessions, tooling, and channel
 * routes. This module re-exports the alias and provides routing-state
 * helpers that operate on the canonical type.
 *
 * Trust resolution itself lives in actor-trust-resolver.ts; the resolved
 * ActorTrustContext is converted to GuardianRuntimeContext via
 * toGuardianRuntimeContextFromTrust.
 */
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import {
  resolveActorTrust,
  type ResolveActorTrustInput,
  toGuardianRuntimeContextFromTrust,
  type TrustClass,
} from './actor-trust-resolver.js';
export type { DenialReason } from './actor-trust-resolver.js';

/** Trust classification used by route-level channel logic. */
export type ActorTrustClass = TrustClass;

/**
 * GuardianContext is the canonical runtime trust context.
 *
 * Previously this was a separate interface with extra fields (memberStatus,
 * memberPolicy). Those fields were only needed for InboundActorContext
 * construction, which now sources them directly from ActorTrustContext.
 * This alias unifies the two shapes and removes the redundant conversion
 * layer.
 */
export type GuardianContext = GuardianRuntimeContext;

export type ResolveGuardianContextInput = ResolveActorTrustInput;

/**
 * Resolve route-level trust context from canonical identity state.
 *
 * Delegates to resolveActorTrust for classification, then converts to
 * the canonical GuardianRuntimeContext via toGuardianRuntimeContextFromTrust.
 */
export function resolveGuardianContext(input: ResolveGuardianContextInput): GuardianContext {
  const trust = resolveActorTrust(input);
  return toGuardianRuntimeContextFromTrust(trust, input.conversationExternalId);
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
export function resolveRoutingState(ctx: Pick<GuardianRuntimeContext, 'trustClass' | 'guardianExternalUserId'>): RoutingState {
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
  return resolveRoutingState(ctx);
}

/**
 * Override the sourceChannel on a resolved GuardianRuntimeContext.
 *
 * The HTTP /messages endpoint resolves trust against a fixed internal
 * channel ('vellum') but the request body carries the actual sourceChannel
 * (e.g. the channel the gateway routed the request through). This helper
 * copies the context with the caller-supplied sourceChannel.
 */
export function toGuardianRuntimeContext(
  sourceChannel: import('../channels/types.js').ChannelId,
  ctx: GuardianRuntimeContext,
): GuardianRuntimeContext {
  return { ...ctx, sourceChannel };
}
