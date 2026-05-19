/**
 * Tests for the in-memory privacy-consent handoff.
 *
 * `Date.now` is spied on (rather than injected through the public API) so
 * the signals module stays a plain pair of side-effecting functions —
 * matches the direct-`Date.now` convention elsewhere in `@/lib`.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  __testing,
  clearPrivacyConsent,
  hasRecentPrivacyConsent,
  markPrivacyConsent,
} from "@/lib/onboarding/signals.js";

const USER_A = "user-a";
const USER_B = "user-b";

afterEach(() => {
  __testing.reset();
});

describe("privacy consent handoff", () => {
  test("returns false when nothing has been marked", () => {
    expect(hasRecentPrivacyConsent(USER_A)).toBe(false);
  });

  test("mark → has-recent returns true for the same user", () => {
    markPrivacyConsent(USER_A);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
  });

  test("read is non-mutating (strict-mode double mount safety)", () => {
    markPrivacyConsent(USER_A);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
  });

  test("clear invalidates a prior mark", () => {
    markPrivacyConsent(USER_A);
    clearPrivacyConsent();
    expect(hasRecentPrivacyConsent(USER_A)).toBe(false);
  });

  test("marker expires after 30s", () => {
    let clock = 1_000_000;
    const spy = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      markPrivacyConsent(USER_A);
      expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
      clock += 29_999;
      expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
      clock += 2;
      expect(hasRecentPrivacyConsent(USER_A)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("a second user in the same tab cannot inherit the first user's consent", () => {
    // Codex P1 regression guard: user A consents, user A's session ends,
    // user B signs in within the 30s TTL. The marker is still "fresh" in
    // wall-clock terms but belongs to A — B must NOT satisfy the gate.
    markPrivacyConsent(USER_A);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(true);
    expect(hasRecentPrivacyConsent(USER_B)).toBe(false);
  });

  test("null userId cannot mark and cannot read", () => {
    markPrivacyConsent(null);
    expect(hasRecentPrivacyConsent(null)).toBe(false);
    expect(hasRecentPrivacyConsent(USER_A)).toBe(false);
    markPrivacyConsent(USER_A);
    expect(hasRecentPrivacyConsent(null)).toBe(false);
  });
});
