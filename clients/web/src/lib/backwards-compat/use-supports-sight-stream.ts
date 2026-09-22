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
 * MIN_VERSION is one published dev build's whole version string,
 * `0.11.7-dev.202609010224.44cd29e`, rather than a release or a rounded
 * boundary. Every tidier-looking constant admits or excludes the wrong builds,
 * so the shape is load-bearing and worth stating.
 *
 * It is a dev version because `main` carries the version of the last cut, so
 * every build off it is named `0.11.7-dev.*` whether or not it has the handler
 * and only the suffix separates them. `versionSupports` compares two same-base
 * dev builds through `comparePreRelease`, segment by segment and numerically
 * where both segments are digits, so the timestamp is what does the
 * separating, and a version carrying a segment where the floor has run out is
 * the greater of the two.
 *
 * It names a sha because a dev version's timestamp records when the release
 * workflow computed it, not what the build contains: a run can be dispatched
 * against any ref and stamps the minute it runs. A floor naming a bare minute
 * therefore admits a later-stamped build whose commit is older than the
 * handler.
 *
 * The format has one ambiguity, stated rather than papered over: a build
 * stamped in this same minute ties on the timestamp and falls through to a
 * comparison of short shas, which are ordered lexically and mean nothing in
 * that order (an all-digit short sha sorts below any sha carrying a letter, via
 * the numeric-versus-not branch). Naming a build that exists is what keeps that
 * hypothetical.
 *
 * Three constants that look tidier and are not:
 *
 * - **`0.11.8`**, or any release floor, keeps handler-bearing builds dark. An
 *   assistant packaged from `main` has the frame and reports `0.11.7-dev.*`,
 *   which sits below a 0.11.8 base until the next cut, so the room would
 *   sample nothing on exactly the builds this was written for.
 * - **`0.11.7-dev.0`** goes too far the other way. It reads as "any dev build
 *   of 0.11.7", which admits the dev builds of that base that have no handler,
 *   and each of them refuses every keep with the code the transport reads as
 *   an `update_config` rejection.
 * - **A bare minute** such as `0.11.7-dev.202609010135` admits a build stamped
 *   after that minute from a commit older than the handler, for the reason
 *   above.
 *
 * Do NOT replace this with any of them. The stable 0.11.7 release is excluded
 * by the `dev` suffix alone (a dev build outranks its own base's release, see
 * `use-supports-voice-camera.ts` for that writeup), and each wrong constant
 * fails a row in this gate's test.
 *
 * Scoped to the assistant that owns the live voice session, so a version held
 * for the outgoing assistant cannot authorize a frame against the incoming one.
 *
 * Delete this gate, and the `MIN_VERSION` branch in `use-voice-room-sight.ts`,
 * once the minimum supported assistant is >= MIN_VERSION.
 */
import { assistantScopedSupports, useAssistantScopedSupports } from "./utils";

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

/**
 * The same answer as a snapshot, for callers that are not components: the
 * companion mirror reads it inside a store subscription to tell the surface
 * whether the running call can be shown the screen.
 */
export function supportsSightStream(
  sessionAssistantId: string | null | undefined,
): sessionAssistantId is string {
  return assistantScopedSupports(MIN_VERSION, sessionAssistantId);
}
