/**
 * Shared inbound trust resolution for channel actors.
 *
 * Provides routing-state helpers and a convenience wrapper
 * ({@link resolveTrustContext}) around {@link resolveActorTrust} that
 * converts the result to a {@link TrustContext}.
 *
 * Trust resolution itself lives in `actor-trust-resolver.ts`; the resolved
 * {@link ActorTrustContext} is converted to {@link TrustContext} via
 * {@link toTrustContext}.
 */
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import {
  resolveActorTrust,
  type ResolveActorTrustInput,
  toTrustContext,
} from "./actor-trust-resolver.js";

/**
 * Resolve route-level trust context from canonical identity state.
 *
 * Delegates to resolveActorTrust for classification, then converts to
 * the canonical TrustContext via toTrustContext.
 */
export function resolveTrustContext(
  input: ResolveActorTrustInput,
): TrustContext {
  const trust = resolveActorTrust(input);
  return toTrustContext(trust, input.conversationExternalId);
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
export function resolveRoutingState(
  ctx: Pick<TrustContext, "trustClass" | "guardianExternalUserId">,
): RoutingState {
  const isGuardian = ctx.trustClass === "guardian";
  const isTrustedContact = ctx.trustClass === "trusted_contact";

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
 * Convenience: compute routing state from a TrustContext
 * (the shape persisted in stored payloads and used by the retry sweep).
 */
export function resolveRoutingStateFromRuntime(
  ctx: TrustContext,
): RoutingState {
  return resolveRoutingState(ctx);
}

/**
 * Override the sourceChannel on a resolved TrustContext.
 *
 * The HTTP /messages endpoint resolves trust against a fixed internal
 * channel ('vellum') but the request body carries the actual sourceChannel
 * (e.g. the channel the gateway routed the request through). This helper
 * copies the context with the caller-supplied sourceChannel.
 */
export function withSourceChannel(
  sourceChannel: import("../channels/types.js").ChannelId,
  ctx: TrustContext,
): TrustContext {
  return { ...ctx, sourceChannel };
}
