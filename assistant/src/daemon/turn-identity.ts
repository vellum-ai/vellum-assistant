/**
 * The identity a turn executes under: who is acting, with what authorization,
 * over which channel.
 *
 * A `Conversation` is long-lived and every inbound message writes to it,
 * including while a turn is running: transport metadata is re-applied before a
 * message is enqueued, so the live `trustContext` / `authContext` /
 * `channelCapabilities` can move under an in-flight turn. Anything a turn
 * reads therefore has to be captured when the turn starts.
 *
 * Holding those facts on one object is what makes the capture reliable. The
 * agent loop builds the identity as a turn begins and drops it as the turn
 * ends, so a fact added here is covered by that teardown with no further
 * action, and no turn can read a fact belonging to a different one.
 *
 * A fact belongs here when its correct value is a property of *this message*
 * rather than of the conversation, and when reading a later message's value
 * mid-turn would be wrong. Facts that legitimately outlive a turn (history,
 * workspace state, the conversation's resting trust used to seed a new turn)
 * stay on `Conversation`.
 *
 * Capabilities are deliberately absent: `resolveCapabilities` derives them
 * from `trust.trustClass` at point of use, and caching a derived set here
 * would give it a lifetime of its own.
 */

import type { AuthContext } from "../runtime/auth/types.js";
// Type-only, so this stays a leaf module at runtime despite the heavier
// module the shape is declared in.
import type { ChannelCapabilities } from "./conversation-runtime-assembly.js";
import type { TrustContext } from "./trust-context-types.js";

export interface TurnIdentity {
  /**
   * Trust the turn runs under. Governs `trustClass`, `executionChannel`, and
   * `requesterExternalUserId` for every tool call in the turn, so the whole
   * approval path follows whichever actor this names.
   */
  readonly trust: TrustContext;
  /** Auth snapshot for turn-scoped authorization decisions. */
  readonly authContext?: AuthContext;
  /**
   * JWT-verified principal that owns the turn, for host-proxy routing. Kept
   * distinct from `authContext.actorPrincipalId`: the `/v1/messages` path
   * resolves a principal without necessarily carrying a full auth context.
   */
  readonly sourceActorPrincipalId?: string;
  /** Channel capabilities as they were when the turn started. */
  readonly channelCapabilities?: ChannelCapabilities;
}

/**
 * Build the identity for a turn that is starting.
 *
 * Anything omitted is absent rather than inherited: a turn that cannot say who
 * is acting must not borrow the answer from whoever acted last.
 */
export function createTurnIdentity(input: {
  trust: TrustContext;
  authContext?: AuthContext;
  sourceActorPrincipalId?: string;
  channelCapabilities?: ChannelCapabilities;
}): TurnIdentity {
  return {
    trust: input.trust,
    authContext: input.authContext,
    sourceActorPrincipalId: input.sourceActorPrincipalId,
    channelCapabilities: input.channelCapabilities,
  };
}
