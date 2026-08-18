import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";

const MAX_TRACKED_IPS = 50_000;

afterEach(() => {
  setSystemTime();
});

describe("AuthRateLimiter", () => {
  describe("isBlocked", () => {
    test("unknown IP is never blocked", () => {
      const limiter = new AuthRateLimiter(3, 60_000);
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    });

    test("not blocked below the failure threshold", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(3, 60_000);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    });

    test("blocked at the failure threshold", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(3, 60_000);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    });

    test("blocked above the failure threshold", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(3, 60_000);
      for (let i = 0; i < 10; i++) limiter.recordFailure("1.2.3.4");
      expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    });

    test("failures at exactly windowMs ago are expired and not counted", () => {
      const windowMs = 60_000;
      const base = 1_000_000;
      setSystemTime(new Date(base));
      const limiter = new AuthRateLimiter(3, windowMs);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");

      setSystemTime(new Date(base + windowMs));
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    });

    test("failures just inside the window still count", () => {
      const windowMs = 60_000;
      const base = 1_000_000;
      setSystemTime(new Date(base));
      const limiter = new AuthRateLimiter(3, windowMs);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");

      setSystemTime(new Date(base + windowMs - 1));
      expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    });

    test("partial expiry: IP remains blocked when enough failures are still in window", () => {
      const windowMs = 60_000;
      const base = 1_000_000;
      const limiter = new AuthRateLimiter(3, windowMs);

      setSystemTime(new Date(base));
      limiter.recordFailure("1.2.3.4");

      setSystemTime(new Date(base + 1));
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");

      // Advance so the T=base failure expires but the T=base+1 ones remain
      setSystemTime(new Date(base + windowMs));
      expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    });

    test("all failures expired: entry is removed and IP is unblocked", () => {
      const windowMs = 60_000;
      const base = 1_000_000;
      setSystemTime(new Date(base));
      const limiter = new AuthRateLimiter(3, windowMs);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");

      setSystemTime(new Date(base + windowMs + 1));
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    });

    test("different IPs are tracked independently", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(3, 60_000);
      limiter.recordFailure("1.1.1.1");
      limiter.recordFailure("1.1.1.1");
      limiter.recordFailure("1.1.1.1");

      expect(limiter.isBlocked("1.1.1.1")).toBe(true);
      expect(limiter.isBlocked("2.2.2.2")).toBe(false);
    });
  });

  describe("clearIp", () => {
    test("clears failure state so the IP is unblocked", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(3, 60_000);
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      limiter.recordFailure("1.2.3.4");
      expect(limiter.isBlocked("1.2.3.4")).toBe(true);

      limiter.clearIp("1.2.3.4");
      expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    });

    test("clearIp on an unknown IP is a no-op", () => {
      const limiter = new AuthRateLimiter(3, 60_000);
      expect(() => limiter.clearIp("9.9.9.9")).not.toThrow();
      expect(limiter.isBlocked("9.9.9.9")).toBe(false);
    });
  });

  describe("capacity management", () => {
    test("stale IPs are evicted at capacity, making room for new ones", () => {
      const windowMs = 60_000;
      const base = 1_000_000;
      setSystemTime(new Date(base));
      const limiter = new AuthRateLimiter(3, windowMs);

      for (let i = 0; i < MAX_TRACKED_IPS; i++) {
        limiter.recordFailure(`192.168.${Math.floor(i / 256)}.${i % 256}`);
      }

      // Advance past the window so all existing entries are stale
      setSystemTime(new Date(base + windowMs + 1));

      // Recording a new IP should evict the stale entries
      const newIp = "10.0.0.1";
      limiter.recordFailure(newIp);

      // After eviction + insert, the new IP should be tracked (not blocked yet — only 1 failure)
      expect(limiter.isBlocked(newIp)).toBe(false);
      limiter.recordFailure(newIp);
      limiter.recordFailure(newIp);
      expect(limiter.isBlocked(newIp)).toBe(true);
    });

    test("hard cap drops the oldest entry when all tracked IPs have active failures", () => {
      setSystemTime(new Date(1));
      const limiter = new AuthRateLimiter(3, 60_000);

      // Fill to capacity; insertion order makes "ip-0" the oldest
      const oldest = "ip-0";
      limiter.recordFailure(oldest);
      for (let i = 1; i < MAX_TRACKED_IPS; i++) {
        limiter.recordFailure(`ip-${i}`);
      }

      // All entries are active (windowMs=60000, only 1ms elapsed)
      setSystemTime(new Date(2));
      const newIp = "ip-new";
      limiter.recordFailure(newIp);

      // The oldest IP was evicted; the new one is recorded
      expect(limiter.isBlocked(oldest)).toBe(false);
      limiter.recordFailure(newIp);
      limiter.recordFailure(newIp);
      expect(limiter.isBlocked(newIp)).toBe(true);
    });

    test("existing IP can always record more failures even at capacity", () => {
      setSystemTime(new Date(0));
      const limiter = new AuthRateLimiter(10, 60_000);

      const knownIp = "known-ip";
      limiter.recordFailure(knownIp);

      for (let i = 0; i < MAX_TRACKED_IPS - 1; i++) {
        limiter.recordFailure(`filler-${i}`);
      }

      // Map is now at capacity; recording another failure for an already-tracked IP
      // must not throw or trigger eviction of other entries
      for (let i = 0; i < 9; i++) {
        limiter.recordFailure(knownIp);
      }
      expect(limiter.isBlocked(knownIp)).toBe(true);
    });
  });
});
