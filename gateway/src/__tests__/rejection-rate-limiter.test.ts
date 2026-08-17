import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { RejectionRateLimiter } from "../rejection-rate-limiter.js";

const COOLDOWN_MS = 5 * 60 * 1000; // must match REJECTION_NOTICE_COOLDOWN_MS
const MAX_CACHE_SIZE = 10_000; // must match MAX_REJECTION_CACHE_SIZE
const BASE = 1_000_000; // non-zero so setSystemTime actually takes effect

afterEach(() => {
  setSystemTime();
});

describe("RejectionRateLimiter", () => {
  describe("shouldSend", () => {
    test("first call for a recipient always returns true", () => {
      const limiter = new RejectionRateLimiter();
      expect(limiter.shouldSend("user-1")).toBe(true);
    });

    test("second call within the cooldown window returns false", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();
      limiter.shouldSend("user-1");

      setSystemTime(new Date(BASE + COOLDOWN_MS - 1));
      expect(limiter.shouldSend("user-1")).toBe(false);
    });

    test("call at exactly the cooldown boundary is allowed through", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();
      limiter.shouldSend("user-1");

      // now - lastSent === COOLDOWN_MS is not < COOLDOWN_MS, so it passes
      setSystemTime(new Date(BASE + COOLDOWN_MS));
      expect(limiter.shouldSend("user-1")).toBe(true);
    });

    test("after the cooldown window elapses, a notice is sent again", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();
      expect(limiter.shouldSend("user-1")).toBe(true);

      setSystemTime(new Date(BASE + COOLDOWN_MS + 1));
      expect(limiter.shouldSend("user-1")).toBe(true);
    });

    test("cooldown window resets after each successful send", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();
      limiter.shouldSend("user-1");

      setSystemTime(new Date(BASE + COOLDOWN_MS + 1));
      limiter.shouldSend("user-1");

      // Within the second cooldown window
      setSystemTime(new Date(BASE + COOLDOWN_MS + 2));
      expect(limiter.shouldSend("user-1")).toBe(false);

      // After the second window
      setSystemTime(new Date(BASE + 2 * COOLDOWN_MS + 2));
      expect(limiter.shouldSend("user-1")).toBe(true);
    });

    test("different recipients are tracked independently", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();
      limiter.shouldSend("user-a");
      limiter.shouldSend("user-b");

      setSystemTime(new Date(BASE + 1));
      expect(limiter.shouldSend("user-a")).toBe(false);
      expect(limiter.shouldSend("user-b")).toBe(false);

      setSystemTime(new Date(BASE + COOLDOWN_MS + 1));
      expect(limiter.shouldSend("user-a")).toBe(true);
      expect(limiter.shouldSend("user-b")).toBe(true);
    });
  });

  describe("capacity management", () => {
    test("stale entries are purged when cache is full, making room without hard-capping", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();

      for (let i = 0; i < MAX_CACHE_SIZE; i++) {
        limiter.shouldSend(`user-${i}`);
      }

      // All existing entries are now stale
      setSystemTime(new Date(BASE + COOLDOWN_MS + 1));

      // A new recipient should trigger the purge path, not the hard cap
      const newRecipient = "user-new";
      expect(limiter.shouldSend(newRecipient)).toBe(true);

      // Verify the new entry is tracked (within-cooldown call returns false)
      setSystemTime(new Date(BASE + COOLDOWN_MS + 2));
      expect(limiter.shouldSend(newRecipient)).toBe(false);
    });

    test("hard cap drops the oldest entries when no stale entries exist", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();

      // Fill to capacity; first inserted recipient is the oldest
      const oldestRecipient = "recipient-0";
      limiter.shouldSend(oldestRecipient);
      for (let i = 1; i < MAX_CACHE_SIZE; i++) {
        limiter.shouldSend(`recipient-${i}`);
      }

      // Advance slightly so entries are still active but we have a fresh 'now'
      setSystemTime(new Date(BASE + 1));
      const newRecipient = "recipient-new";
      expect(limiter.shouldSend(newRecipient)).toBe(true);

      // The oldest entry was evicted — it can send again immediately
      setSystemTime(new Date(BASE + 2));
      expect(limiter.shouldSend(oldestRecipient)).toBe(true);
    });

    test("an entry already in the map bypasses the capacity check", () => {
      setSystemTime(new Date(BASE));
      const limiter = new RejectionRateLimiter();

      const knownRecipient = "known";
      limiter.shouldSend(knownRecipient);

      for (let i = 0; i < MAX_CACHE_SIZE - 1; i++) {
        limiter.shouldSend(`filler-${i}`);
      }

      // Cache is at capacity; within-cooldown call for a known recipient
      // short-circuits before hitting the capacity branch
      setSystemTime(new Date(BASE + 1));
      expect(limiter.shouldSend(knownRecipient)).toBe(false);
    });
  });
});
