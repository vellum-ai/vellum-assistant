/**
 * Wait for a WebSocket's close handshake to finish, bounded by a timeout.
 *
 * Used by the pre-checkpoint quiesce: `close()` only starts the handshake,
 * and a checkpoint taken mid-handshake would still capture the socket. On
 * timeout the socket is forcibly terminated (Bun's client WebSocket exposes
 * `terminate()`; absent that, the socket is abandoned — the wait still ends
 * so the quiesce response is never blocked indefinitely).
 */

// Well under vembda's 5s quiesce POST timeout, leaving room for the daemon
// relay and both gateway clients to close sequentially.
export const CHECKPOINT_CLOSE_WAIT_MS = 2_000;

export function waitForWebSocketClose(
  ws: WebSocket,
  timeoutMs: number = CHECKPOINT_CLOSE_WAIT_MS,
): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        (ws as unknown as { terminate?: () => void }).terminate?.();
      } catch {
        // socket already broken — nothing more to force
      }
      resolve();
    }, timeoutMs);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
