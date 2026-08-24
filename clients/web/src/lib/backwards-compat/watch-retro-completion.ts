/**
 * Backwards-compat gate: the announcement that a watch session's summary is
 * finished.
 *
 * Watching itself is gated separately, by `watch-sessions.ts`. This gate
 * answers a different question at a different edge: whether the assistant a
 * session belongs to emits the `watch_retro_completed` event that settles the
 * wait a deliberate stop opens.
 *
 * If an assistant serves sessions without announcing their retrospectives, a
 * stop opens a wait nothing can end. The companion surface stays expanded on
 * "Summarizing" until the give-up timer in `watch/watch-retro.ts` runs out, and
 * that timer is three minutes because it is sized for a turn that reads a whole
 * session, not for a routine ending. A floating window sitting over the user's
 * work claiming to be busy for three minutes after every session is worse than
 * the surface saying nothing at all.
 *
 * - Old behavior (< MIN_VERSION): a stop returns the surface straight to
 *   resting, exactly as it did before the summary existed. The retrospective
 *   still runs on the assistant and still writes its report; the user simply is
 *   not told about it here.
 * - New behavior (>= MIN_VERSION): a stop opens the pending wait, and the
 *   runtime's `watch_retro_completed` on the assistant's event stream ends it.
 *
 * Scoped to the assistant the session belongs to, via
 * `assistantScopedSupports`, for the same reason `watch-sessions.ts` is: the
 * announcement arrives on that assistant's event stream, and a version fetched
 * for the outgoing assistant must not authorize a wait on the incoming one's.
 *
 * MIN_VERSION is the watch stream's own floor, imported rather than stamped
 * again. The route and this event reach `main` in the same merge (#41133), so
 * no shipped build serves a session it cannot announce the retrospective for,
 * and a second constant would only be a second thing to keep in step.
 *
 * **While the two share a floor this gate cannot refuse.** A stop edge only
 * exists for a session that started, and a session only starts for an
 * assistant that cleared the stream's floor, which is this one, so the gate
 * reads true wherever it is reachable. It stays its own gate because it
 * answers its own question, and a caller reading
 * `supportsWatchRetroCompletion` at the stop edge should not have to know the
 * two share a number today. If the announcement ever moves to a later build,
 * stamping this from that build parts them without touching a call site.
 */

import { assistantScopedSupports } from "@/lib/backwards-compat/utils";
import { MIN_VERSION as WATCH_STREAM_MIN_VERSION } from "@/lib/backwards-compat/watch-sessions";

export const MIN_VERSION = WATCH_STREAM_MIN_VERSION;

/**
 * Whether `assistantId` announces a finished watch retrospective.
 *
 * Snapshot rather than a hook, and with no `resolveSupports…` companion,
 * because the only caller is the stop edge in `watch-controller.ts`, which is
 * synchronous by contract: everything the user can perceive has to end inside
 * the press. It does not need one either. A session can only be stopped if it
 * was started, and the start already awaited the scoped version for this same
 * assistant behind `resolveSupportsWatchSessions`, so by the time a stop can
 * reach this the version is hydrated and owned. The conservative `false` is
 * left for the cases where it is the right answer anyway: a logout that cleared
 * identity has no event stream to hear an announcement on.
 */
export function supportsWatchRetroCompletion(
  assistantId: string | null | undefined,
): assistantId is string {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
