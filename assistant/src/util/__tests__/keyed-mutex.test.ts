import { describe, expect, test } from "bun:test";

import { createKeyedMutex } from "../keyed-mutex.js";

/** A deferred promise plus its resolver, for hand-controlling op timing. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createKeyedMutex", () => {
  test("serializes operations sharing a key (no interleaving)", async () => {
    const mutex = createKeyedMutex();
    const events: string[] = [];

    const a = defer();
    const b = defer();

    const opA = mutex("slug", async () => {
      events.push("A:start");
      await a.promise;
      events.push("A:end");
    });
    const opB = mutex("slug", async () => {
      events.push("B:start");
      await b.promise;
      events.push("B:end");
    });

    // B must NOT start until A has fully settled, even though both were
    // submitted synchronously and A is still awaiting.
    await Promise.resolve();
    expect(events).toEqual(["A:start"]);

    a.resolve();
    await opA;
    // Now A is done; B should have begun.
    await Promise.resolve();
    expect(events).toEqual(["A:start", "A:end", "B:start"]);

    b.resolve();
    await opB;
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  test("runs operations on different keys concurrently", async () => {
    const mutex = createKeyedMutex();
    const events: string[] = [];

    const a = defer();
    const b = defer();

    const opA = mutex("slug-a", async () => {
      events.push("A:start");
      await a.promise;
      events.push("A:end");
    });
    const opB = mutex("slug-b", async () => {
      events.push("B:start");
      await b.promise;
      events.push("B:end");
    });

    // Both should have started without waiting on each other.
    await Promise.resolve();
    expect(events).toEqual(["A:start", "B:start"]);

    b.resolve();
    await opB;
    a.resolve();
    await opA;
    expect(events).toEqual(["A:start", "B:start", "B:end", "A:end"]);
  });

  test("a rejected operation does not poison the queue for its key", async () => {
    const mutex = createKeyedMutex();

    const failed = mutex("slug", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");

    const ok = await mutex("slug", async () => 42);
    expect(ok).toBe(42);
  });

  test("preserves submission order under a same-key burst", async () => {
    const mutex = createKeyedMutex();
    const order: number[] = [];

    const ops = [0, 1, 2, 3, 4].map((i) =>
      mutex("slug", async () => {
        // Yield to prove ordering comes from the mutex, not sync execution.
        await Promise.resolve();
        order.push(i);
      }),
    );

    await Promise.all(ops);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("drops map entries once a key's queue drains", async () => {
    const mutex = createKeyedMutex();
    expect(mutex.size).toBe(0);

    await mutex("slug", async () => {});
    // Allow the cleanup microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(mutex.size).toBe(0);
  });
});
