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
 * `attach_image` speculatively would therefore do two bad things at once — the
 * photo would silently never reach the model, and the transport would latch
 * `configUpdatesUnsupported` and stop applying the voice-room settings for the
 * rest of the session.
 *
 * So this is a WRITE gate, and write gates hide the affordance rather than
 * letting it fail (see docs/BACKWARDS_COMPAT.md): below `MIN_VERSION` the room
 * shows no camera control at all. A camera that opens and silently drops every
 * photo is worse than one that isn't offered.
 *
 * MIN_VERSION is 0.12.0. The frame landed after 0.11.2 was cut, and a later
 * 0.11.x patch could ship without it, so 0.12.0 is the first release
 * GUARANTEED to contain it. Erring high is nearly free here — the only cost is
 * the camera staying hidden on a 0.11.x patch that happens to carry the frame,
 * and it appears as soon as the assistant updates. Erring low costs a photo
 * the user watched themselves take that the assistant never saw, plus a
 * session whose settings quietly stop applying.
 *
 * The gate is scoped to the assistant that owns the live voice session via
 * `useAssistantScopedSupports` — see its JSDoc in `./utils.ts` for the atomic
 * version+owner snapshot and conservative-on-mismatch semantics.
 *
 * Delete this gate — and the `MIN_VERSION` branch at the camera control in
 * `voice-room.tsx` — once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.12.0";

/**
 * Returns `true` when the assistant that owns the live voice session
 * (`sessionAssistantId`) understands the `attach_image` frame, so the voice
 * room can offer its camera.
 *
 * On the `false` branch — below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases — the
 * room renders no camera control.
 */
export function useSupportsVoiceCamera(
  sessionAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, sessionAssistantId);
}
