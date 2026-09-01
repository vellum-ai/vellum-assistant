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
 * MIN_VERSION is `0.11.7-dev.202609010135`: a pinned dev-build timestamp, not
 * a release. That is unusual enough to be worth the paragraph, and both of the
 * tidier-looking constants are wrong.
 *
 * The floor is the first dev build that can carry the handler. `main` carries
 * the version of the last cut, so every build off it is named `0.11.7-dev.*`
 * whether or not it has the frame, and only the timestamp in the suffix tells
 * them apart. `versionSupports` compares two same-base dev builds by that
 * suffix (`comparePreRelease`, numeric segment by segment), so a timestamp is
 * the one thing that can separate them.
 *
 * The anchor is the daemon change's squash merge, commit 3251f98402, committed
 * at 2026-09-01T01:34:30Z. Dev versions stamp `dev.YYYYMMDDHHMM.<sha>` at the
 * moment the release workflow computes them, so a build stamped `...0134` may
 * have been computed in the seconds BEFORE the merge landed and carry a
 * pre-merge sha. Rounding up to the next whole minute, `...0135`, removes the
 * ambiguity. It costs at most one build: one computed in the last 29 seconds
 * of the merge minute has the handler and is refused until the next dev
 * release. That is the safe direction to be wrong in.
 *
 * The floor names no sha, and does not need one. `comparePreRelease` walks
 * segments and treats a version that still has segments where the floor has
 * run out as the greater of the two, so `dev.202609010135.abcdef01` clears
 * `dev.202609010135` rather than tying with it.
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

export const MIN_VERSION = "0.11.7-dev.202609010135";

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
