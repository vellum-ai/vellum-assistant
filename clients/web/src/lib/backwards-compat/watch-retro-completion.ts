/**
 * Backwards-compat gate: the announcement that a watch session's summary is
 * finished.
 *
 * Watching itself is gated separately, by `watch-sessions.ts`, and the two
 * floors are not the same instant. The `/v1/watch/stream` route landed first;
 * the `watch_retro_completed` event that settles the wait afterwards landed on
 * a later commit. So there is a real band of assistant versions that run
 * sessions perfectly well and never say anything when the retrospective is
 * done, and the newest web bundle talks to all of them.
 *
 * Without a floor of its own, every deliberate stop against such an assistant
 * opens a wait nothing can end. The companion surface stays expanded on
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
 * MIN_VERSION is a dev floor rather than a predicted release number, per the
 * guidance in `docs/BACKWARDS_COMPAT.md`. It names the commit that added the
 * event and the runtime dispatch behind it (`b796564`, 2026-08-20 22:15 UTC) on
 * top of the then-current base `0.11.4`. Every later release satisfies it
 * without anyone having to guess a number, and dev builds cut after that commit
 * light up.
 *
 * The same caveat `watch-sessions.ts` carries applies here and for the same
 * reason: the commit landed on the `learning-by-watching` feature branch, and
 * dev builds are cut from `main`, so a build taken from `main` between that
 * instant and the branch merging carries the floor's timestamp without the
 * event. The comparison keys on that timestamp rather than on the sha, so a
 * squash restamping the commit does not move the floor. That window is internal
 * dogfood builds only, and it degrades to the pre-gate behavior: the wait opens,
 * nothing settles it, and the give-up timer returns the surface to resting.
 * Re-stamp this to the main-merge commit if the branch sits unmerged.
 */

import { assistantScopedSupports } from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.4-dev.202608202215.b796564";

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
