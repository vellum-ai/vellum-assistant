import { describe, expect, test } from "bun:test";

import { createSurfaceMutex } from "../daemon/conversation-surfaces.js";

describe("createSurfaceMutex cleanup", () => {
  test("map entry is removed after the queue drains", async () => {
    const mutex = createSurfaceMutex();
    await mutex("surface-1", () => "done");
    // Allow the cleanup microtask to run
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });

  test("map entry persists while operations are queued", async () => {
    const mutex = createSurfaceMutex();
    let resolveBlocker!: () => void;
    const blocker = new Promise<void>((r) => {
      resolveBlocker = r;
    });

    // Start a blocking operation
    const p1 = mutex("surface-1", () => blocker);
    // Queue a second operation behind it
    const p2 = mutex("surface-1", () => "second");

    // Map should have an entry while ops are in flight
    expect(mutex.size).toBe(1);

    resolveBlocker();
    await p1;
    await p2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });

  test("many distinct surfaces are cleaned up after draining", async () => {
    const mutex = createSurfaceMutex();
    const count = 200;

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(mutex(`surface-${i}`, () => i));
    }
    await Promise.all(promises);
    // Allow cleanup microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });

  test("cleanup does not remove entry if a new operation was queued", async () => {
    const mutex = createSurfaceMutex();
    let resolveFirst!: () => void;
    const firstBlocker = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const p1 = mutex("surface-1", () => firstBlocker);

    // Resolve first op — its cleanup microtask will schedule
    resolveFirst();
    await p1;

    // Queue a new operation before the cleanup microtask runs.
    // We use a blocking promise to keep the chain alive.
    let resolveSecond!: () => void;
    const secondBlocker = new Promise<void>((r) => {
      resolveSecond = r;
    });
    const p2 = mutex("surface-1", () => secondBlocker);

    // Let microtasks settle — the first cleanup should see a different tail
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(1);

    resolveSecond();
    await p2;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });

  test("error in operation does not prevent cleanup", async () => {
    const mutex = createSurfaceMutex();
    try {
      await mutex("surface-1", () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });

  test("concurrent surfaces are tracked independently", async () => {
    const mutex = createSurfaceMutex();
    let resolveA!: () => void;
    let resolveB!: () => void;
    const blockerA = new Promise<void>((r) => {
      resolveA = r;
    });
    const blockerB = new Promise<void>((r) => {
      resolveB = r;
    });

    const pA = mutex("a", () => blockerA);
    const pB = mutex("b", () => blockerB);

    expect(mutex.size).toBe(2);

    resolveA();
    await pA;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Only 'a' should be cleaned up
    expect(mutex.size).toBe(1);

    resolveB();
    await pB;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutex.size).toBe(0);
  });
});
