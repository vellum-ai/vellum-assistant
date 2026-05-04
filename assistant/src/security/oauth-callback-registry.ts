/**
 * In-memory registry for pending OAuth callback states.
 * Used by the gateway-routed OAuth flow to resolve authorization codes
 * back to the runtime code that initiated the OAuth handshake.
 */

/**
 * Sibling: `assistant/src/mcp/mcp-auth-state.ts`. The MCP auth state map sits
 * one layer up from this registry — it tracks polling-visible status per
 * MCP server, while this registry resolves the OAuth code-arrival promise
 * keyed by OAuth `state`. The callback registry is shared by all
 * gateway-transport OAuth flows (MCP and otherwise); the MCP state map is
 * MCP-specific.
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
  // Clear any existing entry for this state to prevent timer leaks and
  // cross-callback timeouts when the same state is registered twice.
  const existing = pendingCallbacks.get(state);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error("OAuth callback superseded by new registration"));
    pendingCallbacks.delete(state);
  }

  const timer = setTimeout(() => {
    const entry = pendingCallbacks.get(state);
    if (entry) {
      pendingCallbacks.delete(state);
      entry.reject(new Error("OAuth callback timed out"));
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
    entry.reject(new Error("OAuth callback registry cleared"));
  }
  pendingCallbacks.clear();
}
