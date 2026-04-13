/**
 * Pure decision helper for the cloud-mode relay reconnect path.
 *
 * Factored out of worker.ts's `cloudReconnectHook` so the ordering
 * between the three possible outcomes (`keep`, `refreshed`, `abort`)
 * can be unit-tested directly without dragging in the chrome.* service
 * worker surface. The hook in worker.ts is a thin async wrapper that
 * reads the stored token + attempt counter, calls
 * {@link decideCloudReconnectAction} synchronously to pick an action,
 * and then actually fires the refresh / returns the decision.
 *
 * The key invariant this file pins (and the round-2 review gap fix
 * that motivated extracting it) is that `kind: 'abort'` MUST be
 * reachable whenever the 1006 refresh budget has been burned through,
 * regardless of whether a previous refresh stashed a still-present
 * token in storage. Before the fix, the hook checked the "keep"
 * early-return before the abort check — so a chain of successful
 * refreshes followed by repeated 1006 closes would silently reuse the
 * same (still-rejected) token forever once the cap was reached,
 * because `abnormalNeedsRefresh` went false and `stored?.token` was
 * still truthy, triggering the keep branch before abort ever ran.
 */
import type { RelayReconnectContext } from './relay-connection.js';
import { CLOUD_AUTH_FAILURE_CLOSE_CODES, isCloudTokenStale, type StoredCloudToken } from './cloud-auth.js';

/** WebSocket close code browsers emit on "abnormal closure". */
export const WS_CLOSE_CODE_ABNORMAL = 1006;

/** Hard cap on consecutive 1006-triggered token refresh attempts. */
export const CLOUD_REFRESH_ATTEMPT_CAP = 3;

/**
 * Possible synchronous outcomes from
 * {@link decideCloudReconnectAction}. The worker hook then:
 *   - `keep`: returns `{ kind: 'keep' }` to the RelayConnection and
 *     lets the helper reuse the existing token.
 *   - `refresh`: calls `refreshCloudToken` and maps the result to
 *     either `{ kind: 'refreshed', token }` or an error abort.
 *   - `abort`: returns `{ kind: 'abort', error }` without touching
 *     the refresh endpoint — used when the budget is exhausted.
 */
export type CloudReconnectAction =
  | { kind: 'keep' }
  | { kind: 'refresh' }
  | { kind: 'abort'; error: string };

export interface CloudReconnectDecisionInput {
  ctx: RelayReconnectContext;
  stored: StoredCloudToken | null;
  /** Consecutive 1006 refresh attempts since the last successful open. */
  attempts: number;
  /** Passed through to {@link isCloudTokenStale} for tests. */
  now?: number;
}

/**
 * Pick a synchronous action for the cloud reconnect hook. See the
 * module docstring for the rationale behind the ordering — in
 * particular, the `budgetExhausted` short-circuit MUST run before the
 * `keep` early-return so a still-present token does not mask the cap.
 */
export function decideCloudReconnectAction(
  input: CloudReconnectDecisionInput,
): CloudReconnectAction {
  const { ctx, stored, attempts, now } = input;
  const authFailure = CLOUD_AUTH_FAILURE_CLOSE_CODES.has(ctx.code);
  const abnormal = ctx.code === WS_CLOSE_CODE_ABNORMAL;
  const abnormalNeedsRefresh = abnormal && attempts < CLOUD_REFRESH_ATTEMPT_CAP;
  const budgetExhausted = abnormal && attempts >= CLOUD_REFRESH_ATTEMPT_CAP;
  const needsRefresh =
    authFailure || abnormalNeedsRefresh || isCloudTokenStale(stored, now);

  // Budget-exhausted short-circuit: MUST run before the keep
  // early-return so a still-present token does not mask the abort.
  if (budgetExhausted) {
    return {
      kind: 'abort',
      error:
        `Cloud relay kept closing with abnormal closure (code 1006) after ${CLOUD_REFRESH_ATTEMPT_CAP} ` +
        "token refresh attempts. Use 'Re-sign in' in Advanced, then turn Connection on again.",
    };
  }

  if (!needsRefresh && stored?.token) {
    return { kind: 'keep' };
  }

  return { kind: 'refresh' };
}
