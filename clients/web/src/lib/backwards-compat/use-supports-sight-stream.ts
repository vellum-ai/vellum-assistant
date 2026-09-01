/**
 * Backwards-compat gate: persisting every kept camera frame as its own message.
 *
 * The voice room's viewfinder uploads a frame its gate kept over the ordinary
 * attachment route and then tells the daemon about it with a `sight_frame`
 * live-voice frame, which persists it into the conversation straight away as a
 * standalone user message that runs no turn. The upload half works against any
 * assistant; the frame does not.
 *
 * A WRITE gate, so it withholds the behavior rather than letting it fail (see
 * docs/BACKWARDS_COMPAT.md): below `MIN_VERSION` nothing is sampled and nothing
 * is sent. An assistant that predates the frame answers `unknown_type`, the
 * same code an old assistant returns for `update_config`, and an ungated
 * sampler would be sending a frame every few seconds into a void while the
 * room's thumbnail claimed the call could see each one.
 *
 * MIN_VERSION is `0.11.7-dev.202609010224.44cd29e`: the exact version string of
 * a build that exists, not a release and not a computed boundary. That is
 * unusual enough to be worth the paragraphs, and every tidier-looking constant
 * is wrong.
 *
 * The floor has to be a dev build at all because `main` carries the version of
 * the last cut, so every build off it is named `0.11.7-dev.*` whether or not it
 * has the handler, and only the suffix tells them apart. `versionSupports`
 * compares two same-base dev builds through `comparePreRelease`, segment by
 * segment and numerically where both segments are digits, so the timestamp is
 * what does the separating.
 *
 * It has to be a PUBLISHED build rather than the minute after the daemon
 * change merged (3251f98402, committed 2026-09-01T01:34:30Z), because the
 * release workflow stamps `dev.YYYYMMDDHHMM.<sha>` when its compute-version
 * step RUNS, not when the run was dispatched. A run queued for a pre-merge sha
 * can therefore emerge stamped well past the merge minute, and against a floor
 * naming a bare minute it would clear on the extra-segment rule (a version with
 * a segment where the floor has run out is the greater) despite having no
 * handler. Predicting the boundary cannot rule that out; naming an artifact
 * can.
 *
 * The artifact is dev-release run 33462421058, which succeeded on head
 * 44cd29e199 (the daemon merge is an ancestor of it) and stamped exactly
 * `0.11.7-dev.202609010224.44cd29e`. It is the first success after the merge:
 * the 01:34 run on the merge commit itself failed, so nothing published in
 * between, and no queued pre-merge run can sit above this floor.
 *
 * One residual ambiguity, stated rather than papered over: another run stamped
 * in this SAME minute would tie on the timestamp and fall through to a
 * comparison of short shas, which are ordered lexically and mean nothing in
 * that order (an all-digit short sha sorts below any sha carrying a letter,
 * via the numeric-versus-not branch). No such run exists in the history around
 * the merge, which is the point: the floor names a real artifact, so the
 * ambiguity is hypothetical rather than something a build could fall into.
 *
 * Two constants that look tidier and are not:
 *
 * - **`0.11.8`** (bare, or any 0.11.8 form) keeps handler-bearing builds dark.
 *   An assistant packaged from `main` today has the frame and reports
 *   `0.11.7-dev.*`, which sits below a 0.11.8 base until the next release cut,
 *   so the room would sample nothing on exactly the builds it was written for.
 * - **`0.11.7-dev.0`** goes too far the other way. It reads as "any dev build
 *   of 0.11.7", which admits the whole window between the 2026-08-27 cut and
 *   the merge: builds with no handler, refusing every keep with the code the
 *   transport reads as an `update_config` rejection.
 * - **A bare minute** such as `0.11.7-dev.202609010135` admits the queued
 *   pre-merge run described above, which is the case this floor was moved to
 *   close.
 *
 * Do NOT replace this with either. The stable 0.11.7 release is excluded by
 * the `dev` suffix alone (a dev build outranks its own base's release, see
 * `use-supports-voice-camera.ts` for that writeup), and each wrong constant
 * fails a row in this gate's test.
 *
 * Scoped to the assistant that owns the live voice session, so a version held
 * for the outgoing assistant cannot authorize a frame against the incoming one.
 *
 * Delete this gate, and the `MIN_VERSION` branch in `use-voice-room-sight.ts`,
 * once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.7-dev.202609010224.44cd29e";

/**
 * Returns `true` when the assistant that owns the live voice session
 * (`sessionAssistantId`) understands the `sight_frame` frame, so the room can
 * sample the viewfinder and stream every keep into the conversation.
 *
 * On the `false` branch (below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases) the room
 * samples nothing and the feature is simply absent.
 */
export function useSupportsSightStream(
  sessionAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, sessionAssistantId);
}
