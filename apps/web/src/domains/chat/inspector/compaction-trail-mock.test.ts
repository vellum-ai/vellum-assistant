/**
 * Sanity tests for the compaction-trail mock module.
 *
 * The mock simulates a real network call (latency + abort signal),
 * so the rest of the inspector can develop against a realistic
 * loading state. These tests pin:
 *
 *  - The simulated fetch resolves with a chronologically-ordered list.
 *  - At least one event has a non-`end_turn` stop reason so the UI's
 *    error-state path is exercised in development.
 *  - Aborting the signal rejects with an AbortError instead of
 *    leaving the promise hanging.
 *
 * When the real API ships, this file deletes alongside the mock —
 * the API tests take over.
 */

import { describe, expect, test } from "bun:test";

import { fetchCompactionTrailMock } from "./compaction-trail-mock.js";

describe("fetchCompactionTrailMock", () => {
  test("resolves with a non-empty, chronologically-ordered event list", async () => {
    const result = await fetchCompactionTrailMock("conv-abc", undefined);

    expect(result.conversationId).toBe("conv-abc");
    expect(result.events.length).toBeGreaterThan(0);

    for (let i = 1; i < result.events.length; i++) {
      const prev = result.events[i - 1]!;
      const curr = result.events[i]!;
      expect(curr.createdAt).toBeGreaterThanOrEqual(prev.createdAt);
    }
  });

  test("includes at least one failure event to exercise the error UI", async () => {
    const result = await fetchCompactionTrailMock("conv-abc", undefined);

    const failures = result.events.filter(
      (e) => e.stopReason != null && e.stopReason !== "end_turn",
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  test("rejects with AbortError when the signal aborts mid-fetch", async () => {
    const controller = new AbortController();
    const promise = fetchCompactionTrailMock("conv-abc", controller.signal);
    // Abort before the simulated latency resolves.
    controller.abort();

    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });
});
