/**
 * Default `stop` hook: triggers conversation-title retry/regeneration once a
 * conversation has accumulated useful context.
 *
 * The first title is generated from the opening prompt alone (see
 * `./user-prompt-submit.ts`). After a few exchanges the conversation's real
 * topic is usually clearer, so a single second pass re-titles using the most
 * recent messages. This hook is the trigger — it retries placeholder titles
 * after successful turns and fires the second-pass regeneration when the
 * conversation reaches its third user turn. The service
 * (`persistence/conversation-title-service.ts`) re-checks that the title is still
 * auto-generated, resolves the title provider, persists, and broadcasts the
 * `conversation_title_updated` / `sync_changed` events.
 *
 * Turn count is read from history rather than an external counter: the number
 * of genuine user prompts — user-role messages that aren't purely tool results
 * — is the conversation's turn number. Deriving it from history keeps the hook
 * stateless and means a mid-run array rewrite (compaction) can't invalidate it.
 */

import type { HookFunction, Message, StopContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { getConversation } from "../../../../persistence/conversation-crud.js";
import {
  AUTO_TITLE_DETERMINISTIC,
  isReplaceableTitle,
  queueRegenerateConversationTitle,
} from "../../../../persistence/conversation-title-service.js";

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

function shouldRetryFallbackTitle(conversation: {
  title: string | null;
  isAutoTitle: number;
}): boolean {
  if (!conversation.isAutoTitle) return false;
  return (
    isReplaceableTitle(conversation.title) ||
    conversation.isAutoTitle === AUTO_TITLE_DETERMINISTIC
  );
}

const stop: HookFunction<StopContext> = async (ctx) => {
  // Re-title only at a genuine successful turn end (the model returned a reply
  // with no tool calls). Any other terminal — a provider rejection, abort, or
  // an output-limit cutoff — produced no new topic to re-title from.
  if (ctx.exitReason !== "no_tool_calls") return;

  const userTurns = countUserTurns(ctx.messages);
  if (userTurns === 0) return;

  // System conversations (background/scheduled) keep their deterministic
  // bootstrap title — multi-prompt background jobs can reach three user-role
  // turns with no human present, and a refined LLM title isn't worth the
  // tokens there. The lookup fails open: on a read error the hook behaves as
  // before (queues regeneration; the service re-checks isAutoTitle).
  let retryFallbackTitle = false;
  try {
    const conversation = getConversation(ctx.conversationId);
    if (conversation && conversation.conversationType !== "standard") return;
    retryFallbackTitle = conversation
      ? shouldRetryFallbackTitle(conversation)
      : false;
  } catch {
    // Fall through to queueing.
  }

  if (
    userTurns === SECOND_PASS_USER_TURN &&
    !getConfig().conversations.skipAutoRetitling
  ) {
    const { conversationId } = ctx;
    // Deferred to a later macrotask so the just-completed turn's persistence
    // settles first. The service regenerates from the most recent stored
    // messages, so it must run after the reply is persisted to reflect it. The
    // service is itself fire-and-forget and re-checks replaceability, owning
    // provider resolution, persistence, and the resulting broadcast.
    setTimeout(() => {
      queueRegenerateConversationTitle({ conversationId });
    }, 0);
    return;
  }

  if (retryFallbackTitle) {
    const { conversationId } = ctx;
    setTimeout(() => {
      queueRegenerateConversationTitle({
        conversationId,
        onlyIfReplaceable: true,
      });
    }, 0);
    return;
  }
};

export default stop;
