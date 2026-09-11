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
import { publishMcpChanged } from "./sync.js";

type McpAuthState =
  | { status: "pending"; authUrl: string; attemptId: string; expiresAt: number }
  | {
      status: "complete";
      serverId: string;
      attemptId: string;
      completedAt: number;
    }
  | {
      status: "error";
      error: string;
      attemptId: string;
      failedAt: number;
      cancellationCleanupPending?: boolean;
    };

const activeMcpAuthFlows = new Map<string, McpAuthState>();
const cancellations = new Map<
  string,
  { attemptId: string; cancel: () => void }
>();

export function registerMcpAuthCancellation(
  serverId: string,
  attemptId: string,
  cancel: () => void,
): void {
  cancellations.set(serverId, { attemptId, cancel });
}

export function clearMcpAuthCancellation(
  serverId: string,
  attemptId: string,
): void {
  if (cancellations.get(serverId)?.attemptId === attemptId) {
    cancellations.delete(serverId);
  }
}

export function cancelCurrentMcpAuth(serverId: string): void {
  const current = activeMcpAuthFlows.get(serverId);
  if (current?.status !== "pending") {
    return;
  }
  setMcpAuthError(serverId, "Connection cancelled", current.attemptId);
  cancellations.get(serverId)?.cancel();
  cancellations.delete(serverId);
}

export function setMcpAuthCancellationCleanupPending(
  serverId: string,
  attemptId: string,
  pending: boolean,
): void {
  const current = activeMcpAuthFlows.get(serverId);
  if (current?.status === "error" && current.attemptId === attemptId) {
    activeMcpAuthFlows.set(serverId, {
      ...current,
      cancellationCleanupPending: pending,
      failedAt: Date.now(),
    });
  }
}

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
  void publishMcpChanged();
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
  if (current?.status !== "pending" || current.attemptId !== attemptId) {
    return false; // superseded
  }
  activeMcpAuthFlows.set(serverId, {
    status: "complete",
    serverId,
    attemptId,
    completedAt: Date.now(),
  });
  void publishMcpChanged();
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
  if (current?.status !== "pending" || current.attemptId !== attemptId) {
    return false; // superseded
  }
  activeMcpAuthFlows.set(serverId, {
    status: "error",
    error,
    attemptId,
    failedAt: Date.now(),
  });
  void publishMcpChanged();
  return true;
}

/**
 * Get the current OAuth flow and sweep expired entries. Failed cancellation
 * cleanup remains retryable until settled or superseded.
 */
export function getMcpAuthState(serverId: string): McpAuthState | null {
  const now = Date.now();
  for (const [id, state] of activeMcpAuthFlows) {
    if (state.status === "pending" && now > state.expiresAt) {
      cancellations.get(id)?.cancel();
      cancellations.delete(id);
      activeMcpAuthFlows.delete(id);
    } else if (
      state.status === "complete" &&
      now > state.completedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(id);
    } else if (
      state.status === "error" &&
      !state.cancellationCleanupPending &&
      now > state.failedAt + COMPLETION_GRACE_MS
    ) {
      activeMcpAuthFlows.delete(id);
    }
  }
  return activeMcpAuthFlows.get(serverId) ?? null;
}
