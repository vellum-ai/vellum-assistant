import type { Conversation } from "./conversation.js";
import type { TrustContext } from "./trust-context-types.js";

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

function isContactTrust(trustContext: TrustContext | undefined): boolean {
  return trustContext?.sourceChannel === "vellum-shared";
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
 * The actor work with no sender of its own (a subagent or ACP completion, a
 * wake) runs as: the conversation's resting actor, except while a
 * shared-conversation contact's turn has left the conversation resting on
 * that contact. Such work is never the contact's, so it runs as the actor
 * the conversation rested on before, as it would have had the contact not
 * sent.
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
 * with no sender of its own that is about to run. Does nothing otherwise.
 */
export async function restoreActorBeforeContact(
  conversation: ScopedConversation,
): Promise<void> {
  const actor = actorForWorkWithoutSender(conversation);
  if (actor !== conversation.trustContext) {
    await scopeHistoryToActor(conversation, actor);
  }
}
