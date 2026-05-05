/**
 * In-memory OAuth connect flow status map.
 *
 * Tracks the current state of daemon-owned OAuth connect flows so the CLI
 * can poll for completion via the IPC route.
 */
type OAuthConnectState =
  | { status: "pending"; service: string; expiresAt: number }
  | { status: "complete"; service: string; accountInfo?: string; grantedScopes?: string[]; completedAt: number }
  | { status: "error"; service: string; error: string; failedAt: number };

const activeOAuthConnectFlows = new Map<string, OAuthConnectState>();

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min — matches oauth-callback-registry.ts:14
const COMPLETION_GRACE_MS = 60 * 1000; // 60s so the polling CLI gets one final read

export function setOAuthConnectPending(state: string, service: string): void {
  clearExpiredOAuthConnectStates();
  activeOAuthConnectFlows.set(state, {
    status: "pending",
    service,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

export function setOAuthConnectComplete(
  state: string,
  service: string,
  accountInfo?: string,
  grantedScopes?: string[],
): void {
  clearExpiredOAuthConnectStates();
  activeOAuthConnectFlows.set(state, {
    status: "complete",
    service,
    accountInfo,
    grantedScopes,
    completedAt: Date.now(),
  });
}

export function setOAuthConnectError(
  state: string,
  service: string,
  error: string,
): void {
  clearExpiredOAuthConnectStates();
  activeOAuthConnectFlows.set(state, {
    status: "error",
    service,
    error,
    failedAt: Date.now(),
  });
}

export function getOAuthConnectState(state: string): OAuthConnectState | null {
  clearExpiredOAuthConnectStates();
  return activeOAuthConnectFlows.get(state) ?? null;
}

export function clearExpiredOAuthConnectStates(): void {
  const now = Date.now();
  for (const [key, state] of activeOAuthConnectFlows) {
    if (state.status === "pending" && now > state.expiresAt) {
      activeOAuthConnectFlows.delete(key);
    } else if (state.status === "complete" && now > state.completedAt + COMPLETION_GRACE_MS) {
      activeOAuthConnectFlows.delete(key);
    } else if (state.status === "error" && now > state.failedAt + COMPLETION_GRACE_MS) {
      activeOAuthConnectFlows.delete(key);
    }
  }
}

/** Test-only helper — clears all state for test isolation. */
export function _clearAllOAuthConnectStates(): void {
  activeOAuthConnectFlows.clear();
}
