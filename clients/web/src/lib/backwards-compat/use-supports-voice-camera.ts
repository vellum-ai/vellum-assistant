/**
 * Backwards-compat gate: sending a photo into a live voice call.
 *
 * The camera in the voice room uploads a frame over the ordinary attachment
 * route and then tells the daemon about it with an `attach_image` live-voice
 * frame, which the daemon parks and attaches to the next turn's user message.
 * The upload half works against any assistant; the frame does not.
 *
 * The web app always serves the latest bundle while the assistant can be any
 * locally-installed version, and an assistant that predates the frame answers
 * it with a protocol `error` whose code is `unknown_type`. That error is
 * indistinguishable from the one an old assistant returns for `update_config`:
 * the daemon does not forward the rejected frame's type on the error frame
 * (`live-voice-connection.ts`'s `sendError` sends only `code` and `message`),
 * so the transport's `unknown_type` handler cannot tell the two apart. Sending
 * `attach_image` speculatively would therefore do two bad things at once: the
 * photo would silently never reach the model, and the transport would latch
 * `configUpdatesUnsupported` and stop applying the voice-room settings for the
 * rest of the session.
 *
 * So this is a WRITE gate, and write gates hide the affordance rather than
 * letting it fail (see docs/BACKWARDS_COMPAT.md): below `MIN_VERSION` the room
 * shows no camera control at all. A camera that opens and silently drops every
 * photo is worse than one that isn't offered.
 *
 * MIN_VERSION is 0.11.3, the release this ships in. It is a minimum, so every
 * later version (0.11.4, 0.12.0, and up) passes too.
 *
 * Not 0.11.2: that was cut on 2026-08-04 without the frame, so gating there
 * would offer a camera to every assistant already on the current release, and
 * every photo taken with it would be refused. Not a higher number either,
 * which is the mistake this originally made. The reflex is to pick the next
 * MINOR as the first release "guaranteed" to contain the change, but 0.10 ran
 * to twelve patches, so on this cadence that hides a working camera across
 * potentially months of releases that have it.
 *
 * The number has to track the release that actually carries the change, and
 * releases here are cut as `release/vX.Y.Z` branches with cherry-picks: this
 * merging to main is NOT by itself enough to put it in a given release. If it
 * slips past the 0.11.3 branch cut, this constant has to move with it.
 *
 * The gate is scoped to the assistant that owns the live voice session via
 * `useAssistantScopedSupports`. See its JSDoc in `./utils.ts` for the atomic
 * version+owner snapshot and conservative-on-mismatch semantics.
 *
 * Delete this gate, and the `MIN_VERSION` branch at the camera control in
 * `voice-room.tsx`, once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.3";

/**
 * Returns `true` when the assistant that owns the live voice session
 * (`sessionAssistantId`) understands the `attach_image` frame, so the voice
 * room can offer its camera.
 *
 * On the `false` branch (below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases) the
 * room renders no camera control.
 */
export function useSupportsVoiceCamera(
  sessionAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, sessionAssistantId);
}
