/**
 * Unit tests for the cloud reconnect decision helper.
 *
 * Exercises {@link decideCloudReconnectAction} directly so the ordering
 * between the `keep`, `refresh`, and `abort` branches is pinned by a
 * fast, pure test that doesn't drag in the service worker surface.
 *
 * The round-2 review gap this file covers:
 *   - Gap 1: once `attempts` reaches `CLOUD_REFRESH_ATTEMPT_CAP`, a
 *     subsequent 1006 close MUST produce `{ kind: 'abort' }` even if
 *     `stored?.token` is still present and not stale. Before the fix
 *     the helper's "keep" early-return ran ahead of the abort check,
 *     so a chain of successful refreshes followed by repeated 1006
 *     closes would silently reconnect forever with the rejected
 *     token once the cap was reached.
 */

import { describe, test, expect } from 'bun:test';

import {
  decideCloudReconnectAction,
  CLOUD_REFRESH_ATTEMPT_CAP,
  WS_CLOSE_CODE_ABNORMAL,
} from '../cloud-reconnect-decision.js';
import type { StoredCloudToken } from '../cloud-auth.js';

function freshStoredToken(
  overrides: Partial<StoredCloudToken> = {},
): StoredCloudToken {
  return {
    token: 'jwt-abc',
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes out
    guardianId: 'gdn_1',
    ...overrides,
  };
}

describe('decideCloudReconnectAction', () => {
  test('1006 with fresh token below cap → refresh', () => {
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: freshStoredToken(),
      attempts: 0,
    });
    expect(action.kind).toBe('refresh');
  });

  test('auth-failure close (4001) → refresh regardless of attempts', () => {
    const action = decideCloudReconnectAction({
      ctx: { code: 4001, reason: 'token rotated' },
      stored: freshStoredToken(),
      attempts: 0,
    });
    expect(action.kind).toBe('refresh');
  });

  test('non-1006 clean close with fresh token → keep', () => {
    // Code 1011 is an "internal error" — not a known auth-failure
    // code and not 1006. The decision helper should preserve the
    // existing token and let the relay helper retry.
    const action = decideCloudReconnectAction({
      ctx: { code: 1011, reason: 'internal error' },
      stored: freshStoredToken(),
      attempts: 0,
    });
    expect(action.kind).toBe('keep');
  });

  test('stale stored token → refresh', () => {
    const action = decideCloudReconnectAction({
      ctx: { code: 1011, reason: 'internal error' },
      stored: freshStoredToken({ expiresAt: Date.now() + 1_000 }),
      attempts: 0,
    });
    expect(action.kind).toBe('refresh');
  });

  test('missing stored token with abnormal close → refresh', () => {
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: null,
      attempts: 0,
    });
    expect(action.kind).toBe('refresh');
  });

  test('1006 with attempts == cap-1 still refreshes', () => {
    // Within budget. The caller is expected to bump `attempts` after
    // taking the refresh action.
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: freshStoredToken(),
      attempts: CLOUD_REFRESH_ATTEMPT_CAP - 1,
    });
    expect(action.kind).toBe('refresh');
  });

  test('Gap 1: 1006 with attempts == cap and fresh stored token → abort', () => {
    // This is the exact scenario from the round-2 review. The hook
    // previously returned { kind: 'keep' } here because
    // abnormalNeedsRefresh went false, needsRefresh went false, and
    // the stored token (from a prior successful refresh) was still
    // present and not stale — so the "keep" early-return fired
    // before the abort check. The fix folds the budget-exhausted
    // case into an explicit short-circuit ahead of the keep branch.
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: freshStoredToken(),
      attempts: CLOUD_REFRESH_ATTEMPT_CAP,
    });
    expect(action.kind).toBe('abort');
    if (action.kind === 'abort') {
      expect(action.error).toContain('Cloud relay kept closing');
      expect(action.error).toContain(
        `after ${CLOUD_REFRESH_ATTEMPT_CAP} token refresh attempts`,
      );
      expect(action.error).toContain('sign in');
    }
  });

  test('Gap 1 (4th 1006 simulation): cap-exhausted aborts even after three successful refreshes', () => {
    // Simulates the exact sequence from the bug report:
    //   1. First 1006 → refresh (attempts 0 → 1)
    //   2. Second 1006 → refresh (attempts 1 → 2)
    //   3. Third 1006 → refresh (attempts 2 → 3, now at cap)
    //   4. Fourth 1006 → MUST abort
    //
    // The stored token value is unimportant — what matters is that
    // it is present and not stale (as it would be after a successful
    // refresh), because the bug's trigger was "keep" firing ahead of
    // "abort" specifically when the token looked usable.
    let attempts = 0;
    const stored = freshStoredToken();
    const ctx = { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' };

    // First three 1006 closes refresh.
    for (let i = 0; i < CLOUD_REFRESH_ATTEMPT_CAP; i++) {
      const action = decideCloudReconnectAction({ ctx, stored, attempts });
      expect(action.kind).toBe('refresh');
      attempts += 1;
    }

    // Fourth 1006 close is over budget — must abort.
    const fourth = decideCloudReconnectAction({ ctx, stored, attempts });
    expect(fourth.kind).toBe('abort');
  });

  test('1006 with attempts exceeding cap → still aborts', () => {
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: freshStoredToken(),
      attempts: CLOUD_REFRESH_ATTEMPT_CAP + 5,
    });
    expect(action.kind).toBe('abort');
  });

  test('1006 with no stored token and budget exhausted still aborts', () => {
    // Defensive: without a stored token the keep branch is unreachable
    // anyway, but we pin that the budget-exhausted abort still fires.
    const action = decideCloudReconnectAction({
      ctx: { code: WS_CLOSE_CODE_ABNORMAL, reason: 'abnormal' },
      stored: null,
      attempts: CLOUD_REFRESH_ATTEMPT_CAP,
    });
    expect(action.kind).toBe('abort');
  });

  test('non-1006 close with attempts at cap does NOT abort (cap is 1006-only)', () => {
    // The 1006 budget is specific to abnormal-closure recovery. A
    // 4001 (policy) close should still refresh regardless of the
    // 1006 attempt counter.
    const action = decideCloudReconnectAction({
      ctx: { code: 4001, reason: 'policy violation' },
      stored: freshStoredToken(),
      attempts: CLOUD_REFRESH_ATTEMPT_CAP,
    });
    expect(action.kind).toBe('refresh');
  });
});
