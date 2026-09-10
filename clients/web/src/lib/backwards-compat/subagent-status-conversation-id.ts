/**
 * Backwards-compat gate: the parent conversation on `subagent_status_changed`.
 *
 * Below `MIN_VERSION` the event names no conversation, so a status for a
 * subagent the store has never seen (its `subagent_spawned` was missed, or the
 * store was reset by a conversation switch) can only be scoped by guessing the
 * conversation on screen. A subagent still running in the conversation the
 * user just left is then filed under the one they opened: its card surfaces
 * in the wrong transcript, and the reconcile that follows asks about that
 * conversation, finds no such subagent, and settles it as interrupted while
 * it is still running. At or above `MIN_VERSION` the event carries the parent
 * `conversationId` and the stub is scoped to it.
 *
 * `MIN_VERSION` names the lowest assistant version whose status events carry
 * the field. A dev build stamps the base version in `package.json`, so the
 * gate reads false on dev builds until the base moves; that only matters when
 * the field is missing, which no build that carries it does.
 *
 * Delete this gate, and the on-screen fallback at its call site, once the
 * minimum supported assistant is >= MIN_VERSION.
 */
import { assistantSupports } from "./utils";

export const MIN_VERSION = "0.11.12";

/**
 * Snapshot check (safe in stream handlers): `true` when the connected
 * assistant names the parent conversation on `subagent_status_changed`, so an
 * id-less status is a defect to leave unscoped rather than a cue to guess.
 * Conservative on an unknown or unparseable version (returns `false`).
 */
export function supportsScopedSubagentStatus(): boolean {
  return assistantSupports(MIN_VERSION);
}
