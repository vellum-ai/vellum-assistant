/**
 * Manual `requestAnimationFrame` pump for tests of rAF-driven loops.
 *
 * `installRafTestHarness` swaps the global `requestAnimationFrame` /
 * `cancelAnimationFrame` pair for an id-tracking capture so tests drive frames
 * deterministically: `fireFrame` runs every pending callback once with a
 * controlled timestamp, and callbacks that reschedule land in the next frame's
 * batch. The harness also exposes the pending callbacks, the total number of
 * frame requests, and the ids passed to cancel — enough to assert loop
 * lifecycle (started, rescheduled, canceled on unmount).
 *
 * Install in `beforeEach` and call `restore` in `afterEach` to reinstate the
 * real globals. Callers whose frame callbacks update React state pump through
 * `pumpFrame`, which wraps `fireFrame` in `act()`; `fireFrame` stays raw for
 * loops with no React state involved (canvas draw loops).
 */

import { act } from "@testing-library/react";

export interface RafTestHarness {
  /**
   * Fire every currently pending callback once with the given timestamp
   * (defaults to `performance.now()`).
   */
  fireFrame(timestamp?: number): void;
  /** `fireFrame` wrapped in `act()`, for callbacks that update React state. */
  pumpFrame(timestamp?: number): void;
  /** Callbacks scheduled but not yet fired or canceled. */
  pendingCallbacks(): FrameRequestCallback[];
  /** Total `requestAnimationFrame` calls since install. */
  requestCount(): number;
  /** Ids passed to `cancelAnimationFrame` since install. */
  canceledIds(): readonly number[];
  /** Reinstate the real `requestAnimationFrame` / `cancelAnimationFrame`. */
  restore(): void;
}

export function installRafTestHarness(): RafTestHarness {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let requests = 0;
  const canceled: number[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    requests += 1;
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    canceled.push(id);
    callbacks.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  const fireFrame = (timestamp = performance.now()) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const cb of pending) {
      cb(timestamp);
    }
  };

  return {
    fireFrame,
    pumpFrame(timestamp?: number) {
      act(() => {
        fireFrame(timestamp);
      });
    },
    pendingCallbacks: () => [...callbacks.values()],
    requestCount: () => requests,
    canceledIds: () => canceled,
    restore() {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    },
  };
}
