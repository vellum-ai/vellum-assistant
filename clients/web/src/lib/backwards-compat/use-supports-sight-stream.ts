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
 * MIN_VERSION is `0.11.8`: a base AHEAD of the release this was written
 * against, and bare where the sibling camera gates carry a `-dev.0` suffix.
 * Both halves are deliberate.
 *
 * - **Why 0.11.8 and not 0.11.7.** 0.11.7 was cut on 2026-08-27, before the
 *   daemon learned the frame, and `main` carries the version of the last cut,
 *   so a build that HAS the frame and a build that predates it are both named
 *   `0.11.7-dev.*`. No 0.11.7 floor separates them without pinning a build
 *   timestamp, which is a constant nobody can reason about a month later.
 *   0.11.8 is the first base that provably contains the frame: the change
 *   landed on `main` before that cut, so both 0.11.8 itself and every
 *   `0.11.8-dev.*` build off `main` carry it.
 * - **Why no `-dev.0`.** The suffix on `use-supports-voice-camera.ts` and
 *   `use-supports-sight-frames.ts` exists to exclude the STABLE release of the
 *   base they name, which shipped before the feature. Here the base is already
 *   one past that release, so the suffix would exclude nothing but 0.11.8
 *   itself: a dev build counts as newer than its own base's release, so
 *   `0.11.8-dev.0` would gate the feature off on the release it ships in and
 *   only light up on 0.11.9. Bare `0.11.8` admits the release and its dev
 *   builds alike.
 *
 * The cost is deliberate: until `main`'s base bumps, an assistant built from
 * source sits below this floor and the room samples nothing. Do NOT "fix" the
 * constant downward to light it up locally. A 0.11.7 floor lets a daemon with
 * no handler through, and every keep it refuses is a view the room told the
 * user it had shared.
 *
 * See `use-supports-voice-camera.ts` for the full writeup of how a `dev`
 * suffix compares against the stable release with the same base.
 *
 * Scoped to the assistant that owns the live voice session, so a version held
 * for the outgoing assistant cannot authorize a frame against the incoming one.
 *
 * Delete this gate, and the `MIN_VERSION` branch in `use-voice-room-sight.ts`,
 * once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.8";

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
