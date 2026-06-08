/**
 * Manual reconnect control for the live SSE connection.
 *
 * The connection owner (`sse-service`) registers a handler while a
 * connection is attached; the dev-facing events debug API
 * (`window._vellumDebug.events.reconnectClient`) invokes it to force a
 * disconnect-and-reconnect cycle so QA can exercise the reconnection and
 * post-reconnect catch-up path on demand.
 *
 * Kept separate from `sse-service` so the debug surface can reach the
 * control without importing the React-coupled service, and separate from
 * `stream-debug.ts` so that module stays focused on event/client
 * recording.
 */

/**
 * Tears down the live SSE connection immediately and reopens it after
 * `delayMs` milliseconds. A `delayMs` of 0 reopens on the next tick.
 */
export type SseReconnectHandler = (delayMs: number) => void;

let reconnectHandler: SseReconnectHandler | null = null;

/**
 * Register the handler that forces a manual SSE reconnect. The
 * connection owner registers on attach so the control always targets the
 * currently-live connection; the most recent attach wins.
 */
export function setSseReconnectHandler(handler: SseReconnectHandler): void {
  reconnectHandler = handler;
}

/**
 * Clear the registered handler, but only if it is still `handler`. The
 * identity check stops a stale detach from wiping a handler installed by
 * a newer attach.
 */
export function clearSseReconnectHandler(handler: SseReconnectHandler): void {
  if (reconnectHandler === handler) {
    reconnectHandler = null;
  }
}

/**
 * Force the live SSE connection to disconnect and reconnect after
 * `delayMs` (default 0, clamped to non-negative). Returns `true` if a
 * connection was attached to service the request, `false` if none is
 * currently live.
 */
export function requestSseReconnect(delayMs = 0): boolean {
  if (!reconnectHandler) {
    return false;
  }
  reconnectHandler(Math.max(0, delayMs));
  return true;
}
