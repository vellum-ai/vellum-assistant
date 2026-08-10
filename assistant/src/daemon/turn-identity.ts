/**
 * The identity a turn executes under: who is acting, with what authorization,
 * over which channel.
 *
 * ## Why this is one object rather than fields on `Conversation`
 *
 * A `Conversation` is long-lived and every inbound message writes to it,
 * including while a turn is running: transport metadata is re-applied before a
 * message is enqueued, so the live `trustContext` / `authContext` /
 * `channelCapabilities` can move under an in-flight turn. Anything a turn
 * reads therefore has to be frozen when the turn starts.
 *
 * That freezing used to be done field by field, and the fields were cleared at
 * turn end by a hand-maintained list. A field the list forgot kept its value
 * into the next turn, and whether that produced the wrong actor or no actor at
 * all depended on whether the conversation happened to still be resident in
 * the cache. Every field on this object is cleared together when the turn
 * ends, because there is only one reference to drop.
 *
 * The security-relevant fields lived in exactly the forgotten set. See
 * LUM-3161 for the inventory and LUM-3135 for what it cost.
 *
 * ## What belongs here
 *
 * A fact belongs on the turn when its correct value is a property of *this
 * message* rather than of the conversation, and when reading a later message's
 * value mid-turn would be wrong. Add a field here rather than to
 * `Conversation`; teardown then covers it with no further action.
 *
 * Facts that legitimately outlive a turn (history, workspace state, the
 * conversation's resting trust used to hydrate a fresh turn) stay on
 * `Conversation`.
 */

import type { AuthContext } from "../runtime/auth/types.js";
// Type-only, so this stays a leaf module at runtime despite the heavier
// module the shape is declared in.
import type { ChannelCapabilities } from "./conversation-runtime-assembly.js";
import type { TrustContext } from "./trust-context-types.js";

export interface TurnIdentity {
  /**
   * Trust the turn runs under, captured when the turn started. Governs
   * `trustClass`, `executionChannel`, and `requesterExternalUserId` for every
   * tool call in the turn, so reading a later actor's value here reroutes the
   * whole approval path.
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
 * Callers pass what they resolved for *this* message. Anything omitted is
 * absent rather than inherited: a turn that cannot say who is acting must not
 * borrow the answer from whoever acted last.
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
