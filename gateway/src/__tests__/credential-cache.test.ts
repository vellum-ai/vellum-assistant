import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock readCredential so tests don't touch the real credential store
// ---------------------------------------------------------------------------

let readCredentialImpl: (account: string) => Promise<string | undefined>;

mock.module("../credential-reader.js", () => ({
  readCredential: (account: string) => readCredentialImpl(account),
}));

import { CredentialCache } from "../credential-cache.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let callCount: number;
let callLog: string[];

beforeEach(() => {
  // Restore real Date.now between tests
  Date.now = globalThis.Date.now;
  callCount = 0;
  callLog = [];
  readCredentialImpl = async (account: string) => {
    callCount++;
    callLog.push(account);
    return `value-for-${account}`;
  };
});

// ---------------------------------------------------------------------------
// Basic caching
// ---------------------------------------------------------------------------

describe("CredentialCache", () => {
  test("returns the value from readCredential", async () => {
    const cache = new CredentialCache();
    const result = await cache.get("credential:test:key");
    expect(result).toBe("value-for-credential:test:key");
    expect(callCount).toBe(1);
  });

  test("caches the value within the TTL window", async () => {
    const cache = new CredentialCache({ ttlMs: 5_000 });
    await cache.get("key-a");
    await cache.get("key-a");
    await cache.get("key-a");
    expect(callCount).toBe(1);
  });

  test("re-fetches after TTL expires", async () => {
    const cache = new CredentialCache({ ttlMs: 100 });
    const realNow = Date.now();

    await cache.get("key-a");
    expect(callCount).toBe(1);

    // Move time past TTL
    Date.now = () => realNow + 200;

    await cache.get("key-a");
    expect(callCount).toBe(2);
  });

  test("caches different keys independently", async () => {
    const cache = new CredentialCache();
    await cache.get("key-a");
    await cache.get("key-b");
    expect(callCount).toBe(2);

    // Second reads should be cached
    await cache.get("key-a");
    await cache.get("key-b");
    expect(callCount).toBe(2);
  });

  test("caches undefined values (key not found)", async () => {
    readCredentialImpl = async () => {
      callCount++;
      return undefined;
    };
    const cache = new CredentialCache({ ttlMs: 5_000 });
    const r1 = await cache.get("missing-key");
    const r2 = await cache.get("missing-key");
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(callCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // force: true
  // -------------------------------------------------------------------------

  describe("force option", () => {
    test("force bypasses TTL and fetches fresh value", async () => {
      const cache = new CredentialCache({ ttlMs: 60_000 });
      await cache.get("key-a");
      expect(callCount).toBe(1);

      await cache.get("key-a", { force: true });
      expect(callCount).toBe(2);
    });

    test("force updates the cached value for subsequent non-force reads", async () => {
      let returnValue = "v1";
      readCredentialImpl = async () => {
        callCount++;
        return returnValue;
      };
      const cache = new CredentialCache({ ttlMs: 60_000 });

      expect(await cache.get("key-a")).toBe("v1");
      expect(callCount).toBe(1);

      returnValue = "v2";
      expect(await cache.get("key-a", { force: true })).toBe("v2");
      expect(callCount).toBe(2);

      // Subsequent non-force read should return the updated cached value
      expect(await cache.get("key-a")).toBe("v2");
      expect(callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // In-flight deduplication (coalescing)
  // -------------------------------------------------------------------------

  describe("in-flight deduplication", () => {
    test("concurrent requests for the same key coalesce into one read", async () => {
      let resolveRead!: (val: string | undefined) => void;
      readCredentialImpl = async () => {
        callCount++;
        return new Promise<string | undefined>((resolve) => {
          resolveRead = resolve;
        });
      };

      const cache = new CredentialCache();
      const p1 = cache.get("key-a");
      const p2 = cache.get("key-a");
      const p3 = cache.get("key-a");

      resolveRead("shared-value");

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe("shared-value");
      expect(r2).toBe("shared-value");
      expect(r3).toBe("shared-value");
      expect(callCount).toBe(1);
    });

    test("different keys do not coalesce", async () => {
      const cache = new CredentialCache();
      const [r1, r2] = await Promise.all([
        cache.get("key-a"),
        cache.get("key-b"),
      ]);
      expect(r1).toBe("value-for-key-a");
      expect(r2).toBe("value-for-key-b");
      expect(callCount).toBe(2);
    });

    test("force request coalesces with an in-flight non-force request", async () => {
      let resolveRead!: (val: string | undefined) => void;
      readCredentialImpl = async () => {
        callCount++;
        return new Promise<string | undefined>((resolve) => {
          resolveRead = resolve;
        });
      };

      const cache = new CredentialCache();
      const p1 = cache.get("key-a"); // triggers fetch
      const p2 = cache.get("key-a", { force: true }); // should join existing in-flight

      resolveRead("coalesced-value");

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("coalesced-value");
      expect(r2).toBe("coalesced-value");
      expect(callCount).toBe(1);
    });

    test("after in-flight completes, a new request triggers a fresh fetch if TTL expired", async () => {
      const cache = new CredentialCache({ ttlMs: 50 });
      const realNow = Date.now();

      await cache.get("key-a");
      expect(callCount).toBe(1);

      // Expire TTL
      Date.now = () => realNow + 100;

      await cache.get("key-a");
      expect(callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // refreshNow
  // -------------------------------------------------------------------------

  describe("refreshNow", () => {
    test("refreshNow re-fetches specific keys", async () => {
      const cache = new CredentialCache({ ttlMs: 60_000 });
      await cache.get("key-a");
      await cache.get("key-b");
      expect(callCount).toBe(2);

      await cache.refreshNow(["key-a"]);
      expect(callCount).toBe(3);
      expect(callLog).toEqual(["key-a", "key-b", "key-a"]);
    });

    test("refreshNow with no args refreshes all cached keys", async () => {
      const cache = new CredentialCache({ ttlMs: 60_000 });
      await cache.get("key-a");
      await cache.get("key-b");
      expect(callCount).toBe(2);

      await cache.refreshNow();
      expect(callCount).toBe(4);
      // Both keys should have been refreshed
      expect(callLog.slice(2).sort()).toEqual(["key-a", "key-b"]);
    });

    test("refreshNow updates cached values immediately", async () => {
      let returnValue = "v1";
      readCredentialImpl = async () => {
        callCount++;
        return returnValue;
      };
      const cache = new CredentialCache({ ttlMs: 60_000 });

      expect(await cache.get("key-a")).toBe("v1");

      returnValue = "v2";
      await cache.refreshNow(["key-a"]);

      // Non-force read should now return the refreshed value
      expect(await cache.get("key-a")).toBe("v2");
      expect(callCount).toBe(2); // initial + refreshNow, no extra fetch
    });

    test("refreshNow with empty cache is a no-op", async () => {
      const cache = new CredentialCache();
      await cache.refreshNow();
      expect(callCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // invalidate
  // -------------------------------------------------------------------------

  describe("invalidate", () => {
    test("invalidate clears all cached values", async () => {
      const cache = new CredentialCache({ ttlMs: 60_000 });
      await cache.get("key-a");
      await cache.get("key-b");
      expect(callCount).toBe(2);

      cache.invalidate();

      // Next reads should trigger fresh fetches
      await cache.get("key-a");
      await cache.get("key-b");
      expect(callCount).toBe(4);
    });

    test("invalidate clears in-flight entries", async () => {
      let resolveRead!: (val: string | undefined) => void;
      readCredentialImpl = async () => {
        callCount++;
        return new Promise<string | undefined>((resolve) => {
          resolveRead = resolve;
        });
      };

      const cache = new CredentialCache();
      const p1 = cache.get("key-a"); // starts an in-flight

      cache.invalidate();

      // New request should start a new fetch (not coalesce with old)
      let resolveRead2!: (val: string | undefined) => void;
      readCredentialImpl = async () => {
        callCount++;
        return new Promise<string | undefined>((resolve) => {
          resolveRead2 = resolve;
        });
      };
      const p2 = cache.get("key-a");
      expect(callCount).toBe(2);

      resolveRead("old-value");
      resolveRead2("new-value");

      // p1 still resolves but p2 is the new in-flight
      expect(await p1).toBe("old-value");
      expect(await p2).toBe("new-value");
    });
  });

  // -------------------------------------------------------------------------
  // onInvalidate
  // -------------------------------------------------------------------------

  describe("onInvalidate", () => {
    test("onInvalidate callback is called on invalidate", () => {
      const cache = new CredentialCache();
      let called = false;
      cache.onInvalidate(() => {
        called = true;
      });

      cache.invalidate();
      expect(called).toBe(true);
    });

    test("multiple onInvalidate callbacks are all called", () => {
      const cache = new CredentialCache();
      const calls: number[] = [];
      cache.onInvalidate(() => calls.push(1));
      cache.onInvalidate(() => calls.push(2));

      cache.invalidate();
      expect(calls).toEqual([1, 2]);
    });

    test("unsubscribe prevents callback from being called", () => {
      const cache = new CredentialCache();
      let called = false;
      const unsub = cache.onInvalidate(() => {
        called = true;
      });

      unsub();
      cache.invalidate();
      expect(called).toBe(false);
    });

    test("onInvalidate returns an unsubscribe function that is idempotent", () => {
      const cache = new CredentialCache();
      const calls: number[] = [];
      const unsub = cache.onInvalidate(() => calls.push(1));
      cache.onInvalidate(() => calls.push(2));

      // Double-unsubscribe should be safe
      unsub();
      unsub();

      cache.invalidate();
      expect(calls).toEqual([2]);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    test("readCredential error is propagated and does not pollute cache", async () => {
      readCredentialImpl = async () => {
        callCount++;
        throw new Error("read failed");
      };
      const cache = new CredentialCache();

      await expect(cache.get("key-a")).rejects.toThrow("read failed");
      expect(callCount).toBe(1);

      // Retry should trigger a new fetch (not stuck in broken state)
      readCredentialImpl = async () => {
        callCount++;
        return "recovered";
      };
      expect(await cache.get("key-a")).toBe("recovered");
      expect(callCount).toBe(2);
    });

    test("concurrent requests all see the error when fetch fails", async () => {
      readCredentialImpl = async () => {
        callCount++;
        throw new Error("boom");
      };

      const cache = new CredentialCache();
      const p1 = cache.get("key-a");
      const p2 = cache.get("key-a");

      const results = await Promise.allSettled([p1, p2]);
      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
      expect((results[0] as PromiseRejectedResult).reason.message).toBe("boom");
      expect((results[1] as PromiseRejectedResult).reason.message).toBe("boom");
      expect(callCount).toBe(1); // coalesced into one failing read
    });
  });

  // -------------------------------------------------------------------------
  // Custom TTL
  // -------------------------------------------------------------------------

  describe("custom TTL", () => {
    test("default TTL is 2000ms", async () => {
      const cache = new CredentialCache();
      const realNow = Date.now();

      await cache.get("key-a");
      expect(callCount).toBe(1);

      // 1999ms: still cached
      Date.now = () => realNow + 1_999;
      await cache.get("key-a");
      expect(callCount).toBe(1);

      // 2001ms: expired
      Date.now = () => realNow + 2_001;
      await cache.get("key-a");
      expect(callCount).toBe(2);
    });

    test("custom TTL is respected", async () => {
      const cache = new CredentialCache({ ttlMs: 500 });
      const realNow = Date.now();

      await cache.get("key-a");
      expect(callCount).toBe(1);

      // 499ms: still cached
      Date.now = () => realNow + 499;
      await cache.get("key-a");
      expect(callCount).toBe(1);

      // 501ms: expired
      Date.now = () => realNow + 501;
      await cache.get("key-a");
      expect(callCount).toBe(2);
    });
  });
});
