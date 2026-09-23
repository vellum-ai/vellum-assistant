import type { Conversation } from "./conversation.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import type { TrustCarrier, TrustContext } from "./trust-context-types.js";

type ScopedConversation = Pick<
  Conversation,
  "trustContext" | "setTrustContext" | "ensureActorScopedHistory"
>;

/**
 * The actor each live conversation rested on when a shared-conversation
 * contact's turn took it over. Work that carries no actor of its own runs as
 * the resting actor, so this is who that work ran as before the contact sent.
 */
const actorBeforeContact = new WeakMap<object, TrustContext | undefined>();

/** Whether a trust is a shared-conversation contact's. */
export function isContactTrust(
  trustContext: TrustContext | undefined,
): boolean {
  return trustContext?.sourceChannel === "vellum-shared";
}

/**
 * Whether a shared-conversation contact is involved in work reporting back to
 * a conversation: its starter, the actor the conversation rests on, or the
 * turn it last ran is a contact's. Only then does the work run as the turn
 * that started it; otherwise it resolves its actor as it always has.
 */
export function isContactInvolved(
  conversation: TrustCarrier,
  startedBy: TrustContext | undefined,
): boolean {
  return (
    isContactTrust(startedBy) ||
    isContactTrust(conversation.trustContext) ||
    isContactTrust(conversation.currentTurnTrustContext)
  );
}

/**
 * The trust of the turn running on a conversation, captured by work that turn
 * starts and that reports back after it (a subagent, an ACP session, a
 * background command). When a contact is involved (see `isContactInvolved`),
 * the report runs as this actor, not as whoever the conversation rests on by
 * the time it arrives.
 */
export function trustOfStartingTurn(
  conversationId: string,
): TrustContext | undefined {
  return findConversationOrSubagent(conversationId)?.getTurnOrRestingTrust();
}

/**
 * Stamp the actor a turn is about to run as on the conversation, then load
 * the history scoped for them. The slot is what history loading filters by,
 * so a turn for a different actor than the resident history was loaded for
 * reloads rather than reusing rows that actor may not see.
 */
export async function scopeHistoryToActor(
  conversation: ScopedConversation,
  trustContext: TrustContext | undefined,
): Promise<void> {
  if (
    isContactTrust(trustContext) &&
    !isContactTrust(conversation.trustContext)
  ) {
    actorBeforeContact.set(conversation, conversation.trustContext);
  }
  conversation.setTrustContext(trustContext ?? null);
  await conversation.ensureActorScopedHistory();
}

/**
 * The actor work that no turn started (a scheduled wake, a heartbeat) runs as:
 * the conversation's resting actor, except while a shared-conversation
 * contact's turn has left the conversation resting on that contact. Such work
 * is never the contact's, so it runs as the actor the conversation rested on
 * before, as it would have had the contact not sent.
 */
export function actorForWorkWithoutSender(
  conversation: Pick<Conversation, "trustContext">,
): TrustContext | undefined {
  if (
    isContactTrust(conversation.trustContext) &&
    actorBeforeContact.has(conversation)
  ) {
    return actorBeforeContact.get(conversation);
  }
  return conversation.trustContext;
}

/**
 * Put back the actor and history a conversation had before a
 * shared-conversation contact's turn left it resting on the contact, for work
 * that no turn started and that is about to run. Does nothing otherwise.
 */
export async function restoreActorBeforeContact(
  conversation: ScopedConversation,
): Promise<void> {
  const actor = actorForWorkWithoutSender(conversation);
  if (actor !== conversation.trustContext) {
    await scopeHistoryToActor(conversation, actor);
  }
}
