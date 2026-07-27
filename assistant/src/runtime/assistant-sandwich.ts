import {
  addMessage,
  deleteMessageById,
} from "../persistence/conversation-crud.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("assistant-sandwich");

/**
 * Anti-injection seed for a background turn.
 *
 * Attacker-controllable data goes in `content`, which is written to the
 * conversation in the **assistant** role between two static user-role
 * messages. The LLM treats assistant-role content as its own prior output
 * rather than as instructions, so a malicious payload (a crafted Linear
 * title, a hostile API response, the stdout of a script that fetched an
 * untrusted page) cannot override the action prompt in `postamble`.
 */
export interface AssistantSandwich {
  /** Static, trusted framing. Written as `user`. */
  preamble: string;
  /** Attacker-controllable payload. Written as `assistant`. */
  content: string;
  /** Static, trusted action prompt. Written as `user`. */
  postamble: string;
}

/**
 * Seed a conversation with an {@link AssistantSandwich}.
 *
 * Callers invoke the turn with an empty prompt afterwards — the conversation
 * already carries the seed, so passing the action prompt again would
 * double-inject it.
 *
 * Returns the ids of the messages written so a caller seeding into a
 * pre-existing conversation can undo them if the turn never starts — see
 * {@link unseedAssistantSandwich}.
 */
export async function seedAssistantSandwich(
  conversationId: string,
  sandwich: AssistantSandwich,
): Promise<string[]> {
  const preamble = await addMessage(conversationId, "user", sandwich.preamble, {
    skipIndexing: true,
  });
  const content = await addMessage(
    conversationId,
    "assistant",
    sandwich.content,
    { skipIndexing: true },
  );
  const postamble = await addMessage(
    conversationId,
    "user",
    sandwich.postamble,
    { skipIndexing: true },
  );
  return [preamble.id, content.id, postamble.id];
}

/**
 * Remove a seeded sandwich from a conversation.
 *
 * Seeding writes the payload and the action prompt into conversation history
 * *before* the turn is dispatched. When the dispatch never starts — the
 * conversation turned out to be mid-turn, say — those messages would otherwise
 * linger, leaving untrusted content and a dangling user-role instruction that
 * a later, unrelated turn in the same conversation would read and could act
 * on. Callers seeding into a fresh conversation don't need this (the whole
 * conversation is discarded); callers reusing one do.
 *
 * Best-effort: a failure to clean up is logged, never thrown, so it cannot
 * mask the dispatch error that triggered it.
 */
export function unseedAssistantSandwich(messageIds: string[]): void {
  for (const id of messageIds) {
    try {
      deleteMessageById(id);
    } catch (err) {
      log.warn(
        { err, messageId: id },
        "Failed to remove a seeded sandwich message after a dispatch failure",
      );
    }
  }
}
