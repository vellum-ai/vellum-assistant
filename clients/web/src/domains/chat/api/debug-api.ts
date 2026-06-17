/**
 * Events surface exposed under `window._vellumDebug.events`.
 *
 * Provides live introspection of SSE stream state: active clients, abort
 * signals, and a rolling buffer of the last 1 000 parsed events.
 *
 * Usage (browser console):
 *
 *   window._vellumDebug.events.getClients()
 *   window._vellumDebug.events.getEvents()
 *   const stop = window._vellumDebug.events.subscribe()
 *   // ...events log to the console as they stream in...
 *   stop()
 *
 * The accessors here read directly from the module-state registry in
 * `stream-debug.ts`. Installation onto `window` is performed by
 * `installVellumDebugApi` in `utils/debug-api.ts`, alongside the chat
 * namespace, so both halves of the debug API mount/unmount together.
 */

import {
  type SseDebugClient,
  type SseDebugEventEntry,
  getSseClients,
  getSseEvents,
} from "@/lib/streaming/stream-debug";
import { requestSseReconnect } from "@/lib/streaming/sse-reconnect-control";
import { getReconnectCursor } from "@/lib/streaming/reconnect-cursor";
import { subscribe as subscribeToBus } from "@/lib/event-bus";

export interface ChatDebugEventsApi {
  /** Snapshot of currently-live SSE clients. */
  getClients: () => SseDebugClient[];
  /** Last 1 000 parsed SSE events (most-recent last). */
  getEvents: () => SseDebugEventEntry[];
  /** Global seq cursor tracked by gap detection / reconnect resume. */
  getSeqCursor: () => number | null;
  /**
   * Force the live SSE connection to disconnect and reconnect, optionally
   * staying down for `timeoutMs` (default 0) so the reconnection and
   * post-reconnect catch-up path can be exercised on demand. Returns
   * `true` if an assistant connection was live to service the request,
   * `false` if none was attached.
   */
  reconnectClient: (timeoutMs?: number) => boolean;
  /**
   * Subscribe to the live SSE event stream and `console.log` every event
   * envelope as it arrives. Returns an unsubscribe function — call it to
   * stop logging. Unlike {@link getEvents} (a snapshot of the ring
   * buffer), this is a live tap: only events received after the call are
   * logged.
   */
  subscribe: () => () => void;
}

/**
 * Singleton events surface. Stable identity across the app's lifetime
 * so the consolidated installer can identity-check on teardown.
 */
export const eventsDebugApi: ChatDebugEventsApi = {
  getClients: getSseClients,
  getEvents: getSseEvents,
  getSeqCursor: getReconnectCursor,
  reconnectClient: (timeoutMs) => requestSseReconnect(timeoutMs),
  subscribe: () =>
    subscribeToBus("sse.event", (envelope) => {
      console.log("[_vellumDebug.events]", envelope);
    }),
};
