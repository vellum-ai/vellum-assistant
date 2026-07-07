/**
 * Shared fail-closed deny pieces for an inbound caller the gateway could not
 * vouch for — an unreachable gateway (media-stream server) or an unusable
 * trust verdict (setup router). Both deny lanes speak the same copy and stamp
 * the same unknown-trust context.
 */

import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";

/** Single user-facing copy for the gateway-unavailable inbound deny. */
export const TRUST_UNAVAILABLE_DENY_MESSAGE =
  "The assistant is unable to take this call right now. Please try again later.";

/**
 * Minimal unknown-trust context for the fail-closed deny, where no verdict
 * is available to build real trust from.
 */
export function unresolvedActorTrust(
  otherPartyNumber: string,
): ActorTrustContext {
  return {
    canonicalSenderId: otherPartyNumber || null,
    guardianBindingMatch: null,
    memberRecord: null,
    trustClass: "unknown",
    actorMetadata: {
      identifier: otherPartyNumber || undefined,
      displayName: undefined,
      senderDisplayName: undefined,
      memberDisplayName: undefined,
      username: undefined,
      channel: "phone",
      trustStatus: "unknown",
    },
  };
}
