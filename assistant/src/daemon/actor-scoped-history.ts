import type { AuthContext } from "../runtime/auth/types.js";
import type { Conversation } from "./conversation.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import type { TrustCarrier, TrustContext } from "./trust-context-types.js";
import { turnActorPrincipalId, type TurnActorSource } from "./turn-actor.js";

/**
 * Who a turn runs as, taken together: the trust that governs its permissions
 * and the principal and auth context that decide whose client its host tools
 * reach. Applied as one, so a turn never pairs one actor's trust with
 * another's principal.
 */
export interface TurnActor {
  trustContext?: TrustContext;
  sourceActorPrincipalId?: string;
  authContext?: AuthContext;
}

/** The actor of the turn that started some work, captured when it started. */
export interface WorkStarter extends TurnActor {
  trustContext: TrustContext;
}

/**
 * The starter each live conversation a turn spawned (a subagent's) was
 * started by, for notifications read off the conversation rather than the
 * spawner's own records.
 */
const startersByConversation = new WeakMap<object, WorkStarter>();

/** Record who started the work a spawned conversation runs. */
export function recordWorkStarter(
  conversation: object,
  starter: WorkStarter | undefined,
): void {
  if (starter) {
    startersByConversation.set(conversation, starter);
  }
}

/** Who started the work a spawned conversation runs, if recorded. */
export function workStarterOf(
  conversation: object | undefined,
): WorkStarter | undefined {
  return conversation ? startersByConversation.get(conversation) : undefined;
}

type ScopedConversation = Pick<
  Conversation,
  | "trustContext"
  | "setTrustContext"
  | "ensureActorScopedHistory"
  | "loadedHistoryScope"
>;

/** A conversation's actor slots plus the scope its resident history was loaded for. */
type ContactCarrier = TrustCarrier &
  Partial<Pick<Conversation, "loadedHistoryScope">>;

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
 * a conversation: its starter, the actor the conversation rests on, the turn
 * it last ran, or the scope its resident history was loaded for is a
 * contact's. Only then does the work run as the turn that started it;
 * otherwise it resolves its actor as it always has.
 */
export function isContactInvolved(
  conversation: ContactCarrier,
  startedBy: TrustContext | undefined,
): boolean {
  return (
    isContactTrust(startedBy) ||
    isContactTrust(conversation.trustContext) ||
    isContactTrust(conversation.currentTurnTrustContext) ||
    isContactTrust(conversation.loadedHistoryScope?.trustContext)
  );
}

/**
 * The actor of the turn running on a conversation, captured by work that turn
 * starts and that reports back after it (a subagent, an ACP session, a
 * background command). When a contact is involved (see `isContactInvolved`),
 * the report runs as this actor, not as whoever the conversation rests on by
 * the time it arrives. Undefined when the conversation has no actor at all.
 */
export function startingTurn(conversationId: string): WorkStarter | undefined {
  const conversation = findConversationOrSubagent(conversationId);
  return conversation ? starterOfTurn(conversation) : undefined;
}

/** The actor of the turn running on `conversation`, as a starter. */
export function starterOfTurn(
  conversation: TrustCarrier & TurnActorSource,
): WorkStarter | undefined {
  const trustContext =
    conversation.currentTurnTrustContext ?? conversation.trustContext;
  if (!trustContext) {
    return undefined;
  }
  return {
    trustContext,
    sourceActorPrincipalId: turnActorPrincipalId(conversation),
    authContext: (conversation.currentTurnAuthContext ??
      conversation.authContext) as AuthContext | undefined,
  };
}

/**
 * Stamp a turn's actor on the conversation's per-turn slots before work runs
 * outside the ordinary send path, so tool setup reads one actor's trust,
 * principal and auth context together.
 */
export function stampTurnActor(
  conversation: Pick<
    Conversation,
    | "currentTurnTrustContext"
    | "currentTurnSourceActorPrincipalId"
    | "currentTurnAuthContext"
  >,
  actor: TurnActor,
): void {
  conversation.currentTurnTrustContext = actor.trustContext;
  conversation.currentTurnSourceActorPrincipalId = actor.sourceActorPrincipalId;
  conversation.currentTurnAuthContext = actor.authContext;
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
 * The whole actor work that no turn started runs as while a contact is
 * involved: the trust from {@link actorForWorkWithoutSender}, with the
 * conversation's resting auth context rather than the principal of whatever
 * turn ran last, which may be the contact's.
 */
export function actorWithoutSender(
  conversation: Pick<Conversation, "trustContext" | "authContext">,
): TurnActor {
  return {
    trustContext: actorForWorkWithoutSender(conversation),
    sourceActorPrincipalId: conversation.authContext?.actorPrincipalId,
    authContext: conversation.authContext,
  };
}

/**
 * Put back the actor and history a conversation had before a
 * shared-conversation contact's turn left it resting on the contact, for work
 * that no turn started and that is about to run. Also reloads when the slot
 * already names that actor but the resident history was loaded for a
 * contact. Does nothing otherwise.
 */
export async function restoreActorBeforeContact(
  conversation: ScopedConversation,
): Promise<void> {
  const actor = actorForWorkWithoutSender(conversation);
  if (
    actor !== conversation.trustContext ||
    isContactTrust(conversation.loadedHistoryScope?.trustContext)
  ) {
    await scopeHistoryToActor(conversation, actor);
  }
}
