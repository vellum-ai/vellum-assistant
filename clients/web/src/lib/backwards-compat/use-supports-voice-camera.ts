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
 * MIN_VERSION is `0.11.2-dev.0`, which reads as "anything after 0.11.2
 * stable". The pre-release suffix is doing real work here, so it is worth
 * being explicit about what it buys:
 *
 * - A **dev build** of 0.11.2 passes. `versionSupports` treats a
 *   `0.11.2-dev.*` build as NEWER than 0.11.2 stable (see its JSDoc: a dev
 *   build carries unreleased commits on top of the release it is named for),
 *   and two dev pre-releases compare by the timestamp in the suffix, so any
 *   real `dev.<timestamp>.<sha>` is above `dev.0`. That is what lets this be
 *   exercised on a local build before the release exists.
 * - **0.11.2 stable is excluded**, which is the whole point. It was cut on
 *   2026-08-04 without the frame. A plain `0.11.2` minimum would offer a
 *   camera to everyone already on the current release and refuse every photo
 *   taken with it. Dev-vs-stable at the same base resolves in the dev build's
 *   favour, so naming a dev suffix here excludes the stable release.
 * - **0.11.3 and up pass** on the base comparison alone, before any of the
 *   pre-release logic is reached.
 *
 * Deliberately NOT a higher number, which is the mistake this originally
 * made. The reflex is to pick the next MINOR as the first release
 * "guaranteed" to contain the change, but 0.10 ran to twelve patches, so on
 * this cadence that hides a working camera across potentially months of
 * releases that have it.
 *
 * Accepted edge: a STALE dev build of 0.11.2, made before the camera landed,
 * also passes and shows a camera that errors on every photo. Pinning a
 * timestamp (`dev.202608060000`) would exclude it, at the cost of a constant
 * nobody can reason about later. Rebuilding fixes it, and only developers on
 * dev builds are exposed.
 *
 * The rows above are pinned by `use-supports-voice-camera.test.ts` so a
 * change to the comparison rules cannot silently reopen the stable release.
 *
 * The gate is scoped to the assistant that owns the live voice session via
 * `useAssistantScopedSupports`. See its JSDoc in `./utils.ts` for the atomic
 * version+owner snapshot and conservative-on-mismatch semantics.
 *
 * Delete this gate, and the `MIN_VERSION` branch at the camera control in
 * `voice-room.tsx`, once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.2-dev.0";

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
