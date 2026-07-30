/**
 * Resting trust for a conversation resumed without an inbound actor.
 *
 * Wakes and startup resumes re-enter a conversation that already exists, with
 * no inbound message to derive trust from. They cannot invent an actor, so they
 * reconstruct the trust the conversation sits at when nobody is talking to it.
 */

import { getConversationOriginChannel } from "../persistence/conversation-crud.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "./trust-context.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * Rebuild the trust context a conversation resumes under when no inbound actor
 * is present, or `null` when it cannot be recovered.
 *
 * Only the guardian's own local conversations are recoverable at rest: a
 * remote-channel turn's trust class is stamped per inbound message from the
 * gateway verdict and never persisted, so it cannot be reconstructed here.
 * Local conversations (`originChannel` unset, meaning a desktop/web/CLI turn
 * that never carried a channel message, or the internal `vellum` channel)
 * belong to the guardian owner, so they resume under
 * {@link INTERNAL_GUARDIAN_TRUST_CONTEXT}: the trust class `loadFromDb` needs
 * to rehydrate their guardian-provenance history instead of filtering it to
 * empty, and the class the tool-approval gate reads to let the guardian's own
 * sensitive tools run. Any other origin returns `null` so the caller runs the
 * turn under no reconstructed context rather than a fabricated one, which would
 * either grant a low-trust conversation guardian capability or bury the reply
 * under `unknown` provenance.
 *
 * A conversation id with no row also reads as local, since the origin lookup
 * cannot tell a missing row from a null column. That is inert: every caller
 * resolves the conversation before the trust is applied to anything, and a
 * missing conversation is rejected there (`wakeAgentForOpportunity` returns
 * `not_found`) before a turn runs.
 */
export function recoverRestingTrustContext(
  conversationId: string,
): TrustContext | null {
  const originChannel = getConversationOriginChannel(conversationId);
  if (originChannel === null || originChannel === "vellum") {
    return INTERNAL_GUARDIAN_TRUST_CONTEXT;
  }
  return null;
}
