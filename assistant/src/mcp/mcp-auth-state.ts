/**
 * In-memory MCP OAuth flow status map.
 *
 * Tracks the current state of daemon-owned MCP OAuth flows so the CLI can
 * poll for completion via the IPC route.
 */

type McpAuthState =
  | { status: "pending"; authUrl: string; attemptId: string; expiresAt: number }
  | {
      status: "complete";
      serverId: string;
      attemptId: string;
      completedAt: number;
    }
  | { status: "error"; error: string; attemptId: string; failedAt: number };

const activeMcpAuthFlows = new Map<string, McpAuthState>();

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — matches oauth-callback-registry.ts
const COMPLETION_GRACE_MS = 60 * 1000; // 60s so the polling CLI gets one final read

/**
 * Record that an OAuth flow is pending authorization.
 * Overwrites any prior state for the same serverId (supersede semantics
 * matching registerPendingCallback). The caller must pass an `attemptId`
 * (a unique token per attempt) so that fire-and-forget completion writes
 * can verify they still own the slot before mutating shared state — see
 * `setMcpAuthComplete` / `setMcpAuthError`.
 */
export function setMcpAuthPending(
  serverId: string,
  authUrl: string,
  attemptId: string,
): void {
  activeMcpAuthFlows.set(serverId, {
    status: "pending",
    authUrl,
    attemptId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

/**
 * Record that an OAuth flow completed successfully. Returns true if the
 * write was applied; false if the attempt has been superseded by a newer
 * one (in which case the caller's tail should silently exit without
 * touching state).
 */
export function setMcpAuthComplete(
  serverId: string,
  attemptId: string,
): boolean {
  const current = activeMcpAuthFlows.get(serverId);
  if (current && current.attemptId !== attemptId) {
    return false; // superseded
  }
  activeMcpAuthFlows.set(serverId, {
    status: "complete",
    serverId,
    attemptId,
    completedAt: Date.now(),
  });
  return true;
}

/**
 * Record that an OAuth flow failed. Returns true if the write was applied;
 * false if the attempt has been superseded.
 */
export function setMcpAuthError(
  serverId: string,
  error: string,
  attemptId: string,
): boolean {
  const current = activeMcpAuthFlows.get(serverId);
  if (current && current.attemptId !== attemptId) {
    return false; // superseded
  }
  activeMcpAuthFlows.set(serverId, {
    status: "error",
    error,
    attemptId,
    failedAt: Date.now(),
  });
  return true;
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
