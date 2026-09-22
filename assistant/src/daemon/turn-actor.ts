/**
 * Who the current turn runs as, for host-proxy routing.
 *
 * One definition, used by `Conversation.getTurnActorPrincipalId` and by the
 * surface resolver, because the answer decides whose desktop a tool may reach
 * and two copies of that decision are two chances to disagree.
 */

/** The turn-scoped identity fields the answer is read from. */
export interface TurnActorSource {
  currentTurnSourceActorPrincipalId?: string;
  currentTurnAuthContext?: { actorPrincipalId?: string };
  authContext?: { actorPrincipalId?: string };
  /** See {@link turnActorPrincipalId}. */
  currentTurnActorFallbackSuppressed?: boolean;
}

/**
 * The actor principal that owns the current turn, or `undefined` when no
 * identity is known.
 *
 * The turn's own actor wins, then the turn's auth context, then the
 * conversation's resting one: a `/v1/messages` turn sets only the first two,
 * and the resting context is what an ordinary text turn leaves behind.
 *
 * **`currentTurnActorFallbackSuppressed` stops that walk at the first step.**
 * It marks a turn that resolved its own actor and found none, which is not the
 * same as a turn that never looked. A live-voice turn whose guardian read
 * failed is in exactly that position: it knows the conversation's resting
 * identity and knows it cannot vouch for it, because the gateway may have
 * admitted a guardian the daemon has not caught up with. Walking on would hand
 * that turn the previous occupant's principal and, through it, their connected
 * desktop.
 */
export function turnActorPrincipalId(
  source: TurnActorSource,
): string | undefined {
  if (source.currentTurnActorFallbackSuppressed) {
    return source.currentTurnSourceActorPrincipalId;
  }
  return (
    source.currentTurnSourceActorPrincipalId ??
    source.currentTurnAuthContext?.actorPrincipalId ??
    source.authContext?.actorPrincipalId
  );
}
