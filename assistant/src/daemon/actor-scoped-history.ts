import type { Conversation } from "./conversation.js";
import type { TrustContext } from "./trust-context-types.js";

/**
 * Stamp the actor a turn is about to run as on the conversation, then load
 * the history scoped for them. The slot is what history loading filters by,
 * so a turn for a different actor than the resident history was loaded for
 * reloads rather than reusing rows that actor may not see.
 */
export async function scopeHistoryToActor(
  conversation: Pick<
    Conversation,
    "setTrustContext" | "ensureActorScopedHistory"
  >,
  trustContext: TrustContext,
): Promise<void> {
  conversation.setTrustContext(trustContext);
  await conversation.ensureActorScopedHistory();
}
