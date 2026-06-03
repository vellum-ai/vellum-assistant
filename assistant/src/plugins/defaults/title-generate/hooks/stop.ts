/**
 * Default `stop` hook: triggers the second-pass conversation-title
 * regeneration once a conversation has accumulated enough context.
 *
 * The first title is generated from the opening prompt alone (see
 * `./user-prompt-submit.ts`). After a few exchanges the conversation's real
 * topic is usually clearer, so a single second pass re-titles using the most
 * recent messages. This hook is the trigger — it fires the regeneration when
 * the conversation reaches its third user turn — and delegates the title
 * itself to the service (`memory/conversation-title-service.ts`), which
 * re-checks that the title is still auto-generated, resolves the title
 * provider, persists, and broadcasts the `conversation_title_updated` /
 * `sync_changed` events.
 *
 * Turn count is read from history rather than an external counter: the number
 * of genuine user prompts — user-role messages that aren't purely tool results
 * — is the conversation's turn number. Deriving it from history keeps the hook
 * stateless and means a mid-run array rewrite (compaction) can't invalidate it.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { queueRegenerateConversationTitle } from "../../../../memory/conversation-title-service.js";
import type { Message } from "../../../../providers/types.js";

/**
 * User turn at which the second title pass fires. Matches the
 * `conversations.skipAutoRetitling` opt-out, documented as skipping the
 * regeneration "that fires after the third user turn".
 */
const SECOND_PASS_USER_TURN = 3;

/** A user-role message carrying only tool results, not a fresh prompt. */
function isToolResultMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

/** Count of genuine user prompts in history — the conversation's turn number. */
function countUserTurns(messages: ReadonlyArray<Message>): number {
  let turns = 0;
  for (const message of messages) {
    if (message.role === "user" && !isToolResultMessage(message)) turns++;
  }
  return turns;
}

const stop: PluginHookFn<StopContext> = async (ctx) => {
  // Only re-title at a genuine turn end. A `"continue"` decision means an
  // earlier hook is re-querying the model (e.g. an empty-response nudge), so
  // defer to the eventual terminal stop.
  if (ctx.decision !== "stop") return;

  if (getConfig().conversations.skipAutoRetitling) return;

  if (countUserTurns(ctx.messages) !== SECOND_PASS_USER_TURN) return;

  // Fire-and-forget: the service owns the replaceability gate, provider
  // resolution, persistence, and the resulting broadcast.
  queueRegenerateConversationTitle({ conversationId: ctx.conversationId });
};

export default stop;
