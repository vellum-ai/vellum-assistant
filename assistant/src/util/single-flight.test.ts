import { describe, expect, test } from "bun:test";

import { createKeyedSingleFlight } from "./single-flight.js";

/** Drain microtasks + timers so chained continuations have run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createKeyedSingleFlight", () => {
  test("serializes calls sharing a key in arrival order", async () => {
    const run = createKeyedSingleFlight();
    const order: string[] = [];
    const gateA = deferred<void>();

    const a = run("k", async () => {
      order.push("a:start");
      await gateA.promise;
      order.push("a:end");
      return "a";
    });
    const b = run("k", async () => {
      order.push("b:start");
      return "b";
    });

    // B must not start until A finishes.
    await tick();
    expect(order).toEqual(["a:start"]);

    gateA.resolve();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  test("does not serialize across different keys", async () => {
    const run = createKeyedSingleFlight();
    const order: string[] = [];
    const gate = deferred<void>();

    const a = run("k1", async () => {
      order.push("k1:start");
      await gate.promise;
      order.push("k1:end");
    });
    // k2 runs to completion without waiting on the in-flight k1 call.
    await run("k2", async () => {
      order.push("k2:start");
    });
    expect(order).toEqual(["k1:start", "k2:start"]);

    gate.resolve();
    await a;
    expect(order).toEqual(["k1:start", "k2:start", "k1:end"]);
  });

  test("a rejecting call does not wedge the chain for the same key", async () => {
    const run = createKeyedSingleFlight();
    await expect(
      run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(run("k", async () => "ok")).resolves.toBe("ok");
  });

  test("reset drops abandoned chain entries", async () => {
    const run = createKeyedSingleFlight();
    // A call that never resolves would block every later call sharing its key.
    const never = deferred<void>();
    void run("k", () => never.promise);
    await tick();

    run.reset();

    // After reset, a fresh call for the same key does not wait on the
    // abandoned one.
    await expect(run("k", async () => "fresh")).resolves.toBe("fresh");
  });
});
