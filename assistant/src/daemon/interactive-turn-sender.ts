/**
 * The interactive-turn sender contract, in one place.
 *
 * `Conversation.sendToClient` is conversation-level mutable state: born a
 * no-op, bound to the SSE hub for the duration of an interactive turn, and
 * reset to a no-op when that turn ends. Some subsystems read this
 * conversation-level sender instead of the turn's own `onEvent` sink; the
 * `PermissionPrompter` is the load-bearing one, so a `confirmation_request`
 * raised by a turn that never bound the sender is emitted into the no-op,
 * reaches no client, and hangs until the permission timeout auto-denies.
 * Every path that runs an interactive agent turn MUST therefore bind before
 * the loop and reset after it. The queue drain bypasses `processMessage`,
 * so it uses these helpers directly.
 *
 * The reset is identity-guarded: it only clears a binding this contract
 * installed, so a sender some other subsystem rebound mid-turn is left
 * alone.
 *
 * TRANSITIONAL: this helper is the paved road for a pattern we want less
 * of. Bind/reset of shared mutable sender state is why the drain, the
 * compaction card, and the host-browser proxy have each needed their own
 * restore step. The durable design is a per-turn sink threaded to the
 * prompter and the other conversation-level-sender readers, at which point
 * this module and every call site of it should be deleted. Prefer that
 * refactor over adding new bind/reset call sites.
 */

import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSubagentManager } from "../subagent/index.js";
import type { Conversation } from "./conversation.js";

/**
 * Point the conversation-level sender (and the subagent parent sender) at
 * the SSE hub for the duration of an interactive turn.
 */
export function bindInteractiveTurnSender(conversation: Conversation): void {
  conversation.updateClient(broadcastMessage, false);
  getSubagentManager().updateParentSender(
    conversation.conversationId,
    broadcastMessage,
  );
}

/**
 * Reset the conversation-level sender to a no-op after an interactive turn,
 * unless another subsystem rebound it mid-turn.
 */
export function resetInteractiveTurnSenderIfBound(
  conversation: Conversation,
): void {
  if (conversation.getCurrentSender() === broadcastMessage) {
    conversation.updateClient(() => {}, true);
  }
}
