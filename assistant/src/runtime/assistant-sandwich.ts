import { addMessage } from "../persistence/conversation-crud.js";

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
 */
export async function seedAssistantSandwich(
  conversationId: string,
  sandwich: AssistantSandwich,
): Promise<void> {
  await addMessage(conversationId, "user", sandwich.preamble, {
    skipIndexing: true,
  });
  await addMessage(conversationId, "assistant", sandwich.content, {
    skipIndexing: true,
  });
  await addMessage(conversationId, "user", sandwich.postamble, {
    skipIndexing: true,
  });
}
