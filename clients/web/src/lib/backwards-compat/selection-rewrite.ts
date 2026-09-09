/**
 * Backwards-compat gate: rewriting a selection in place from a hold.
 *
 * A hold over an editable selection sends the selection with the words to
 * `POST /v1/dictation`, whose command mode changes the selection as the words
 * say. Whether the words were an instruction at all is the daemon's call:
 * from `MIN_VERSION` it answers `mode: "question"` for words that asked
 * about the selection ("what does this mean") rather than for a changed
 * version of it, and the client takes those to the assistant instead.
 *
 * - Old behavior (< MIN_VERSION): command mode treats every transcript as an
 *   instruction and returns a "transformed" text for a question too. A client
 *   that pasted it would replace the user's passage with an answer to a
 *   question about it, so no selection is sent and every hold over one is a
 *   question for the assistant.
 * - New behavior (>= MIN_VERSION): an editable selection is sent, an edit is
 *   pasted over it, a question goes to the assistant.
 *
 * MIN_VERSION is the dev build stamped at the commit that taught the daemon
 * to tell edits from questions: 0.11.8 stable was cut before it, so 0.11.8
 * stays on the old behavior, and any dev or local build from that commit on,
 * and 0.11.9 and up, take the new one.
 *
 * Delete this gate, and take the rewrite lane in
 * `global-push-to-talk-bridge.tsx` unconditional, once the minimum supported
 * assistant is >= MIN_VERSION.
 */
import { assistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.8-dev.202609021456.e7361b7";

/**
 * Whether the assistant the hold's words go to tells an edit from a question
 * in command mode, so a selection can be sent with them. Conservative `false`
 * while its version is unknown or belongs to another assistant, which sends
 * the hold down the ask lane every assistant understands.
 */
export function supportsSelectionRewrite(
  assistantId: string | null | undefined,
): boolean {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
