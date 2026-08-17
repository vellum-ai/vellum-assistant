/**
 * The interactive-turn sender contract, in one place.
 *
 * `Conversation.sendToClient` is conversation-level mutable state: born a
 * no-op, bound to the SSE hub for the duration of an interactive turn, and
 * restored when that turn ends. Some subsystems read this conversation-level
 * sender instead of the turn's own `onEvent` sink; the `PermissionPrompter`
 * is the load-bearing one, so a `confirmation_request` raised by a turn that
 * never bound the sender is emitted into the no-op, reaches no client, and
 * hangs until the permission timeout auto-denies. Every path that runs an
 * interactive agent turn MUST therefore bind before the loop and restore
 * after it. The queue drain bypasses `processMessage`, so it uses this
 * helper directly.
 *
 * The restore is a snapshot of the sender state taken at bind time, not an
 * unconditional reset to a no-op: a live binding that predated the turn
 * (e.g. installed by the send route while a non-interactive turn was
 * running) survives the turn, so out-of-turn producers that read the live
 * sender (call transcript and completion notifiers) keep their client. In
 * the ordinary interactive flow the snapshot is the no-op the previous
 * turn's restore left behind, so restoring it is identical to the reset
 * this contract has always performed. The restore is also identity-guarded:
 * it only replaces the hub binding this contract installed, so a sender
 * some other subsystem rebound mid-turn to anything else is left alone.
 *
 * TRANSITIONAL: this helper is the paved road for a pattern we want less
 * of. Bind/restore of shared mutable sender state is why the drain, the
 * compaction card, and the host-browser proxy have each needed their own
 * restore step. The durable design is a per-turn sink threaded to the
 * prompter and the other conversation-level-sender readers, at which point
 * this module and every call site of it should be deleted. Prefer that
 * refactor over adding new bind/restore call sites.
 */

import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { getSubagentManager } from "../subagent/index.js";
import type { Conversation } from "./conversation.js";

/**
 * Point the conversation-level sender (and the subagent parent sender) at
 * the SSE hub for the duration of an interactive turn. Returns the restore
 * closure the turn's cleanup must invoke.
 */
export function bindInteractiveTurnSender(
  conversation: Conversation,
): () => void {
  const previousSender = conversation.getCurrentSender();
  const previousHasNoClient = conversation.hasNoClient;
  conversation.updateClient(broadcastMessage, false);
  getSubagentManager().updateParentSender(
    conversation.conversationId,
    broadcastMessage,
  );
  return () => {
    if (conversation.getCurrentSender() === broadcastMessage) {
      conversation.updateClient(previousSender, previousHasNoClient);
    }
  };
}
