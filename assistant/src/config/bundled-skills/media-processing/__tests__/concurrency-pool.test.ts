import { describe, expect, it } from "bun:test";

import { ConcurrencyPool } from "../services/concurrency-pool.js";

describe("ConcurrencyPool", () => {
  it("allows up to maxConcurrency tasks to run simultaneously", async () => {
    const pool = new ConcurrencyPool(2);

    await pool.acquire();
    await pool.acquire();

    expect(pool.activeCount).toBe(2);
    expect(pool.waitingCount).toBe(0);

    // Third acquire should not resolve immediately
    let thirdResolved = false;
    const thirdPromise = pool.acquire().then(() => {
      thirdResolved = true;
    });

    // Yield the microtask queue so the promise chain can settle if it were going to
    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(pool.waitingCount).toBe(1);

    // Release one slot — third should now resolve
    pool.release();
    await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(pool.activeCount).toBe(2);
    expect(pool.waitingCount).toBe(0);
  });

  it("releases slots on error so the pool does not leak", async () => {
    const pool = new ConcurrencyPool(1);

    const runTask = async () => {
      await pool.acquire();
      try {
        throw new Error("simulated failure");
      } finally {
        pool.release();
      }
    };

    // First task errors and releases its slot
    await expect(runTask()).rejects.toThrow("simulated failure");
    expect(pool.activeCount).toBe(0);

    // Pool should still be usable after the error
    await pool.acquire();
    expect(pool.activeCount).toBe(1);
    pool.release();
  });

  it("rejects maxConcurrency less than 1", () => {
    expect(() => new ConcurrencyPool(0)).toThrow(
      "maxConcurrency must be at least 1",
    );
  });

  it("defaults to maxConcurrency of 10", async () => {
    const pool = new ConcurrencyPool();

    // Acquire 10 slots — all should resolve immediately
    for (let i = 0; i < 10; i++) {
      await pool.acquire();
    }
    expect(pool.activeCount).toBe(10);

    // 11th should queue
    let eleventhResolved = false;
    pool.acquire().then(() => {
      eleventhResolved = true;
    });
    await Promise.resolve();
    expect(eleventhResolved).toBe(false);
    expect(pool.waitingCount).toBe(1);
  });
});
