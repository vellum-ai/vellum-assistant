/**
 * In-memory registry for pending OAuth callback states.
 * Used by the gateway-routed OAuth flow to resolve authorization codes
 * back to the runtime code that initiated the OAuth handshake.
 */

interface PendingCallback {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingCallbacks = new Map<string, PendingCallback>();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function registerPendingCallback(
  state: string,
  resolve: (code: string) => void,
  reject: (error: Error) => void,
  ttlMs = DEFAULT_TTL_MS,
): void {
  const timer = setTimeout(() => {
    const entry = pendingCallbacks.get(state);
    if (entry) {
      pendingCallbacks.delete(state);
      entry.reject(new Error('OAuth callback timed out'));
    }
  }, ttlMs);

  pendingCallbacks.set(state, { resolve, reject, timer });
}

export function consumeCallback(state: string, code: string): boolean {
  const entry = pendingCallbacks.get(state);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(state);
  entry.resolve(code);
  return true;
}

export function consumeCallbackError(state: string, error: string): boolean {
  const entry = pendingCallbacks.get(state);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingCallbacks.delete(state);
  entry.reject(new Error(error));
  return true;
}

export function clearAllCallbacks(): void {
  for (const entry of pendingCallbacks.values()) {
    clearTimeout(entry.timer);
  }
  pendingCallbacks.clear();
}
