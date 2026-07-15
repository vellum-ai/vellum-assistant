/**
 * Selects the active (not completed, not dismissed) `oauth_connect` surface
 * from the live transcript, for rendering inside the voice room.
 *
 * The voice room is a `fixed inset-0 z-50` modal over a blurred, pointer-events
 * disabled transcript, so an `oauth_connect` card attached to a transcript
 * message is invisible and unclickable during a live session — the user can
 * never complete the connect the assistant asked for (JARVIS-1287). The room
 * renders its own instance of the pending card (read from the same snapshot the
 * transcript renders from) so Connect is reachable without leaving voice.
 *
 * Returns the surface object by reference; `attachSurface` / `completeSurface`
 * only mint a new object for the surface that actually changed, so the selector
 * returns a stable reference across unrelated transcript churn (streaming
 * deltas) and does not re-render the room on every token.
 */

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

function findActiveConnectSurface(
  messages: DisplayMessage[],
  dismissed: ReadonlySet<string>,
): Surface | null {
  // Most recent message wins: a later connect request supersedes an earlier one.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const surfaces = messages[i]?.surfaces;
    if (!surfaces) {
      continue;
    }
    for (let j = surfaces.length - 1; j >= 0; j -= 1) {
      const surface = surfaces[j]!;
      if (
        surface.surfaceType === "oauth_connect" &&
        !surface.completed &&
        !dismissed.has(surface.surfaceId)
      ) {
        return surface;
      }
    }
  }
  return null;
}

/**
 * The active pending `oauth_connect` surface to render in the voice room, or
 * `null` when the assistant hasn't asked to connect anything.
 */
export function useActiveConnectSurface(): Surface | null {
  return useChatSessionStore((state) =>
    findActiveConnectSurface(
      state.snapshot?.messages ?? [],
      state.dismissedSurfaceIds,
    ),
  );
}
