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
 *  - The mock is **call-scoped**: different callIds yield different
 *    event counts (deterministically), including the empty case so
 *    the empty-state UI exercises in dev too.
 *
 * When the real API ships, this file deletes alongside the mock —
 * the API tests take over.
 *
 * Hard-coded callIds below are precomputed against the deterministic
 * hash in `mockEventCountForCallId`. If MOCK_EVENTS length changes,
 * regenerate them — there's no looser way to assert "this id yields
 * N events" without coupling tests to the hash function.
 */

import { describe, expect, test } from "bun:test";

import { fetchCompactionTrailMock } from "./compaction-trail-mock";

// `call-4` hashes to the max bucket (5 events) and `call-3` hashes to
// the empty bucket (0 events) — pinned to the current MOCK_EVENTS
// length of 5.
const FULL_TRAIL_CALL_ID = "call-4";
const EMPTY_TRAIL_CALL_ID = "call-3";

describe("fetchCompactionTrailMock", () => {
  test("resolves with a non-empty, chronologically-ordered event list", async () => {
    const result = await fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      undefined,
    );

    expect(result.conversationId).toBe("conv-abc");
    expect(result.events.length).toBeGreaterThan(0);

    for (let i = 1; i < result.events.length; i++) {
      const prev = result.events[i - 1]!;
      const curr = result.events[i]!;
      expect(curr.createdAt).toBeGreaterThanOrEqual(prev.createdAt);
    }
  });

  test("includes at least one failure event to exercise the error UI", async () => {
    const result = await fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      undefined,
    );

    const failures = result.events.filter(
      (e) => e.stopReason != null && e.stopReason !== "end_turn",
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  test("rejects with AbortError when the signal aborts mid-fetch", async () => {
    const controller = new AbortController();
    const promise = fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      controller.signal,
    );
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

  test("is deterministic for a given callId", async () => {
    const a = await fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      undefined,
    );
    const b = await fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      undefined,
    );
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });

  test("returns an empty trail for callIds that hash to the empty bucket", async () => {
    const result = await fetchCompactionTrailMock(
      "conv-abc",
      EMPTY_TRAIL_CALL_ID,
      undefined,
    );
    expect(result.events).toEqual([]);
    // Empty-state UI must still receive the conversationId so it can
    // surface "no compaction ran before this call" without erroring.
    expect(result.conversationId).toBe("conv-abc");
  });

  test("yields different counts for different callIds", async () => {
    const full = await fetchCompactionTrailMock(
      "conv-abc",
      FULL_TRAIL_CALL_ID,
      undefined,
    );
    const empty = await fetchCompactionTrailMock(
      "conv-abc",
      EMPTY_TRAIL_CALL_ID,
      undefined,
    );
    expect(full.events.length).not.toBe(empty.events.length);
  });
});
