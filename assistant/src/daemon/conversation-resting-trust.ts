/**
 * Resting trust for a conversation resumed without an inbound actor.
 *
 * Wakes and startup resumes re-enter a conversation that already exists, with
 * no inbound message to derive trust from. They cannot invent an actor, so they
 * reconstruct the trust the conversation sits at when nobody is talking to it.
 */

import { getConversation } from "../persistence/conversation-crud.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "./trust-context.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * The internal control-plane channel. A conversation stamped with it is the
 * assistant's own, not a remote correspondent's.
 */
const INTERNAL_ORIGIN_CHANNEL = "vellum";

/**
 * Rebuild the trust context a conversation resumes under when no inbound actor
 * is present, or `null` when it cannot be recovered.
 *
 * Only the guardian's own local conversations are recoverable at rest: a
 * remote-channel turn's trust class is stamped per inbound message from the
 * gateway verdict and never persisted, so it cannot be reconstructed here.
 * A local conversation is one whose stored `origin_channel` is either SQL NULL
 * (a desktop/web/CLI turn that never carried a channel message) or the internal
 * `vellum` channel. Those belong to the guardian owner, so they resume under
 * {@link INTERNAL_GUARDIAN_TRUST_CONTEXT}: the trust class `loadFromDb` needs
 * to rehydrate their guardian-provenance history instead of filtering it to
 * empty, and the class the tool-approval gate reads to let the guardian's own
 * sensitive tools run.
 *
 * Everything else returns `null`, and the caller runs the turn under no
 * reconstructed context rather than a fabricated one, which would either grant
 * a low-trust conversation guardian capability or bury the reply under
 * `unknown` provenance. "Everything else" is deliberately the whole remainder,
 * not just the recognized remote channels:
 *
 * - A **missing conversation row** recovers nothing. Callers reject it on their
 *   own path anyway (`wakeAgentForOpportunity` returns `not_found`), so this is
 *   belt and braces rather than the only guard.
 * - An **unrecognized stored value** recovers nothing. This is why the raw
 *   column is read here instead of `getConversationOriginChannel()`: that
 *   accessor runs the value through `parseChannelId`, which maps any string
 *   outside the canonical channel set to the same `null` a genuinely unset
 *   column produces. Reading through it would let a row written by a newer
 *   build, a renamed channel id, or corrupted data pass as local and resume at
 *   guardian trust. Trust is granted only on an origin positively recognized as
 *   local, never on the absence of a recognizable one.
 */
export function recoverRestingTrustContext(
  conversationId: string,
): TrustContext | null {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return null;
  }
  const { originChannel } = conversation;
  if (originChannel === null || originChannel === INTERNAL_ORIGIN_CHANNEL) {
    return INTERNAL_GUARDIAN_TRUST_CONTEXT;
  }
  return null;
}
