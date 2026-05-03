/**
 * In-memory MCP OAuth flow status map.
 *
 * Tracks the current state of daemon-owned MCP OAuth flows so the CLI can
 * poll for completion via the IPC route.
 */

type McpAuthState =
  | { status: "pending"; authUrl: string; expiresAt: number }
  | { status: "complete"; serverId: string; completedAt: number }
  | { status: "error"; error: string; failedAt: number };

const activeMcpAuthFlows = new Map<string, McpAuthState>();

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — matches oauth-callback-registry.ts
const COMPLETION_GRACE_MS = 60 * 1000; // 60s so the polling CLI gets one final read

/**
 * Record that an OAuth flow is pending authorization.
 * Overwrites any prior state for the same serverId (supersede semantics
 * matching registerPendingCallback).
 */
export function setMcpAuthPending(serverId: string, authUrl: string): void {
  activeMcpAuthFlows.set(serverId, {
    status: "pending",
    authUrl,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

/**
 * Record that an OAuth flow completed successfully.
 */
export function setMcpAuthComplete(serverId: string): void {
  activeMcpAuthFlows.set(serverId, {
    status: "complete",
    serverId,
    completedAt: Date.now(),
  });
}

/**
 * Record that an OAuth flow failed.
 */
export function setMcpAuthError(serverId: string, error: string): void {
  activeMcpAuthFlows.set(serverId, {
    status: "error",
    error,
    failedAt: Date.now(),
  });
}

/**
 * Get the current state of an OAuth flow, or null if none exists.
 */
export function getMcpAuthState(serverId: string): McpAuthState | null {
  clearExpiredMcpAuthStates();
  return activeMcpAuthFlows.get(serverId) ?? null;
}

/**
 * Remove expired entries from the auth flow map.
 */
export function clearExpiredMcpAuthStates(): void {
  const now = Date.now();
  for (const [serverId, state] of activeMcpAuthFlows) {
    if (state.status === "pending" && now > state.expiresAt) {
      activeMcpAuthFlows.delete(serverId);
    } else if (
      state.status === "complete" &&
      now > state.completedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(serverId);
    } else if (
      state.status === "error" &&
      now > state.failedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(serverId);
    }
  }
}

/**
 * Test-only helper — clears all auth flow state for test isolation.
 */
export function _clearAllMcpAuthStates(): void {
  activeMcpAuthFlows.clear();
}
