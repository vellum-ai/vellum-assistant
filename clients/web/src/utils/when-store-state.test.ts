import { describe, expect, test } from "bun:test";
import { create } from "zustand";

import { whenStoreState } from "@/utils/when-store-state";

interface Probe {
  resolved: boolean;
  value: number;
}

const makeStore = (initial: Probe) => create<Probe>(() => initial);

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("whenStoreState", () => {
  test("resolves synchronously when the predicate already holds", async () => {
    const store = makeStore({ resolved: true, value: 1 });
    let settled = false;
    void whenStoreState(store, (s) => s.resolved).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(true);
  });

  test("waits for a later state change that satisfies the predicate", async () => {
    const store = makeStore({ resolved: false, value: 0 });
    let settled = false;
    const pending = whenStoreState(store, (s) => s.resolved).then(() => {
      settled = true;
    });

    await tick();
    expect(settled).toBe(false);

    // An unrelated change that doesn't satisfy the predicate must not resolve.
    store.setState({ value: 1 });
    await tick();
    expect(settled).toBe(false);

    store.setState({ resolved: true });
    await pending;
    expect(settled).toBe(true);
  });

  test("resolves on timeout when the predicate never holds", async () => {
    const store = makeStore({ resolved: false, value: 0 });
    const start = Date.now();
    await whenStoreState(store, (s) => s.resolved, { timeoutMs: 10 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(9);
    // The awaited state never arrived; callers read the (still-false) snapshot.
    expect(store.getState().resolved).toBe(false);
  });
});
