/**
 * Plugin-facing facade over the host's system-card writer: a daemon-authored
 * transcript notice, persisted as an assistant row stamped
 * `messageKind: "system_card"` so clients render it as a standalone system
 * notice rather than assistant-persona speech. Plugins use it to tell the user
 * about something the turn did to their input that the model's own reply
 * cannot explain (e.g. an attachment the turn could not send).
 */

import { persistSystemCard as persistHostSystemCard } from "../runtime/routes/canned-message-complete.js";

/**
 * Persist a system card in a conversation's transcript and announce it to
 * connected clients. Returns the persisted message id.
 *
 * The card is not appended to the conversation's in-memory working history, so
 * posting one mid-turn cannot leave a trailing assistant message for the
 * turn's next provider call to continue from.
 */
export async function persistSystemCard(opts: {
  conversationId: string;
  text: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const { id } = await persistHostSystemCard(opts);
  return id;
}
