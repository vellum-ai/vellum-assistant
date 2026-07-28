/**
 * Shared vellum-card conversation pin for guardian-request producers.
 *
 * Guardian cards (access requests, tool grants, tool approvals, questions)
 * that know their originating conversation pass this affinity fragment to
 * `emitNotificationSignal` so the in-app (vellum) card lands inside that
 * conversation instead of one the decision engine picks. The metadata mirrors
 * the target's `source` because `pairDeliveryWithConversation` reuses a
 * conversation only when its source matches the signal's (inbound
 * conversations default to "user"); a stale/missing target falls back to a
 * fresh conversation via the same pairing path.
 */

import { getConversation } from "../persistence/conversation-crud.js";

export interface VellumCardAffinity {
  conversationAffinityHint: { vellum: string };
  conversationMetadata: { source: string };
}

/**
 * Build the emit-signal affinity fragment pinning the vellum card to
 * `destinationConversationId`, or `undefined` when the producer has no
 * originating conversation (callers spread the result:
 * `...(buildVellumCardAffinity(id) ?? {})`).
 */
export function buildVellumCardAffinity(
  destinationConversationId: string | undefined,
): VellumCardAffinity | undefined {
  if (!destinationConversationId) {
    return undefined;
  }
  return {
    conversationAffinityHint: { vellum: destinationConversationId },
    conversationMetadata: {
      source: getConversation(destinationConversationId)?.source ?? "user",
    },
  };
}
