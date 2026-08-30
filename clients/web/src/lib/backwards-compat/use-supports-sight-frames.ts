/**
 * Backwards-compat gate: parking a camera frame for the next voice turn.
 *
 * The voice room's viewfinder uploads a sampled frame over the ordinary
 * attachment route and then tells the daemon about it with an `attach_frame`
 * live-voice frame, which parks the id so the next turn carries it. The upload
 * half works against any assistant; the frame does not.
 *
 * A WRITE gate, so it withholds the behavior rather than letting it fail (see
 * docs/BACKWARDS_COMPAT.md): below `MIN_VERSION` nothing is sampled and nothing
 * is sent. An assistant that predates the frame answers `unknown_type`, the
 * same code an old assistant returns for `update_config`, and speculatively
 * sending would risk the transport latching `configUpdatesUnsupported` for the
 * rest of the session.
 *
 * MIN_VERSION is `0.11.7-dev.0`, which reads as "anything after 0.11.7
 * stable". 0.11.7 was cut on 2026-08-27 without the frame, which landed on
 * `main` on 2026-08-30, so the stable release must be excluded while dev builds
 * from after it pass. See `use-supports-voice-camera.ts` for the full writeup
 * of how a `dev` suffix compares against the stable release with the same base,
 * and for the accepted edge (a stale dev build of the same base passes).
 *
 * Scoped to the assistant that owns the live voice session, so a version held
 * for the outgoing assistant cannot authorize a frame against the incoming one.
 *
 * Delete this gate, and the `MIN_VERSION` branch in `use-voice-room-sight.ts`,
 * once the minimum supported assistant is >= MIN_VERSION.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.11.7-dev.0";

/**
 * Returns `true` when the assistant that owns the live voice session
 * (`sessionAssistantId`) understands the `attach_frame` frame, so the room can
 * sample the viewfinder and park frames for the turns that follow.
 *
 * On the `false` branch (below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases) the room
 * samples nothing and the feature is simply absent.
 */
export function useSupportsSightFrames(
  sessionAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, sessionAssistantId);
}
