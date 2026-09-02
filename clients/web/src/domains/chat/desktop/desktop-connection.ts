/**
 * Transport for the pod desktop stream: which URL to dial, and what the
 * socket's close code means once it is gone.
 */

import { resolveGatewayWsUrl } from "@/domains/chat/voice/live-voice/connection";

const DESKTOP_STREAM_ROUTE = "/v1/desktop/stream";

// Mirrors the assistant's `DESKTOP_CLOSE`; the rationale is in ARCHITECTURE.md.
const DESKTOP_CLOSE_UNAVAILABLE = 4008;
const DESKTOP_CLOSE_FAILED = 4011;
const DESKTOP_CLOSE_BUSY = 4013;

/**
 * Why a desktop session is over, as the panel explains it.
 *
 * - `busy`: another viewer holds the single session slot.
 * - `unavailable`: the assistant cannot serve a desktop (flag off, not a
 *   containerized pod, or a paired deployment with no WebSocket transport).
 * - `failed`: the desktop did not start, died, or the handshake was refused.
 * - `lost`: anything else, which is a connection worth retrying.
 */
export type DesktopEndReason = "busy" | "unavailable" | "failed" | "lost";

/** Map a WebSocket close code to the reason the panel shows for it. */
export function desktopEndReasonForClose(code: number): DesktopEndReason {
  switch (code) {
    case DESKTOP_CLOSE_BUSY:
      return "busy";
    case DESKTOP_CLOSE_UNAVAILABLE:
      return "unavailable";
    case DESKTOP_CLOSE_FAILED:
      return "failed";
    default:
      return "lost";
  }
}

/**
 * Resolve the desktop stream WebSocket URL for `assistantId`. Thin wrapper
 * over {@link resolveGatewayWsUrl} for the `/v1/desktop/stream` route.
 */
export function resolveDesktopStreamWsUrl(
  assistantId: string,
): Promise<string> {
  return resolveGatewayWsUrl({
    assistantId,
    routePath: DESKTOP_STREAM_ROUTE,
    label: "desktop",
  });
}
