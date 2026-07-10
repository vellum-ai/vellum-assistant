/**
 * In-memory MCP OAuth flow status map.
 *
 * Tracks the current state of daemon-owned MCP OAuth flows so the CLI can
 * poll for completion via the IPC route.
 */

/**
 * Sibling: `assistant/src/security/oauth-callback-registry.ts`. The two look
 * similar (in-memory map, supersede semantics, ~5 min TTL) but live at
 * different layers. The callback registry stores the deferred resolve/reject
 * pair for a single OAuth code arrival, keyed by OAuth `state`. This file
 * stores observable status (pending / complete / error) keyed by serverId so
 * the polling CLI can render progress without holding a long-lived IPC
 * connection.
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
 * Servers whose in-session token refresh failed and which now require a fresh
 * browser authorization. Distinct from the polled flow state above: this is a
 * passive marker set by the OAuth provider when the SDK's mid-session refresh
 * falls through to a new authorization it cannot complete non-interactively.
 * It is cleared whenever tokens are persisted successfully.
 */
const mcpNeedsReauthAt = new Map<string, number>();
const NEEDS_REAUTH_TTL_MS = 5 * 60 * 1000;

/** Record that a server needs interactive re-authentication. */
export function markMcpNeedsReauth(serverId: string): void {
  mcpNeedsReauthAt.set(serverId, Date.now());
}

/** Clear a server's needs-reauth marker (e.g. after tokens are persisted). */
export function clearMcpNeedsReauth(serverId: string): void {
  mcpNeedsReauthAt.delete(serverId);
}

/** Whether a server currently needs interactive re-authentication. */
export function mcpNeedsReauth(serverId: string): boolean {
  const at = mcpNeedsReauthAt.get(serverId);
  if (at === undefined) {
    return false;
  }
  if (Date.now() > at + NEEDS_REAUTH_TTL_MS) {
    mcpNeedsReauthAt.delete(serverId);
    return false;
  }
  return true;
}

/**
 * Get the current state of an OAuth flow, or null if none exists. Sweeps
 * expired entries on every read so a long-polling CLI can never observe
 * a stale flow past its TTL.
 */
export function getMcpAuthState(serverId: string): McpAuthState | null {
  const now = Date.now();
  for (const [id, state] of activeMcpAuthFlows) {
    if (state.status === "pending" && now > state.expiresAt) {
      activeMcpAuthFlows.delete(id);
    } else if (
      state.status === "complete" &&
      now > state.completedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(id);
    } else if (
      state.status === "error" &&
      now > state.failedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(id);
    }
  }
  return activeMcpAuthFlows.get(serverId) ?? null;
}
