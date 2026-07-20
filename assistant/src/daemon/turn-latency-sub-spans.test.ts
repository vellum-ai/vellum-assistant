import { afterAll, describe, expect, spyOn, test } from "bun:test";

import {
  MIN_SUB_SPAN_MS,
  recordLatencySubSpan,
  runWithLatencySubSpans,
  timeLatencySubSpan,
} from "./turn-latency-sub-spans.js";
import {
  MEMORY_CONTEXT_PHASE_KEY,
  TurnLatencyTracker,
} from "./turn-latency-tracker.js";

// Drive `Date.now()` deterministically so measured spans are exact.
let clock = 0;
const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
afterAll(() => nowSpy.mockRestore());

/**
 * Serialize the tracker's `memory_context` phase and return its sub-phases.
 * Marks advance the mocked clock so every phase span is non-negative.
 */
function subPhasesOf(t: TurnLatencyTracker) {
  t.mark("turn_start");
  clock += 10;
  t.mark("prompt_hook_start");
  clock += 10;
  t.mark("prompt_hook_end");
  return t
    .serializeSince(0)
    .breakdown?.phases.find((p) => p.key === MEMORY_CONTEXT_PHASE_KEY)
    ?.subPhases;
}

describe("turn-latency-sub-spans", () => {
  test("timeLatencySubSpan records into the scoped tracker and preserves the return value", async () => {
    const tracker = new TurnLatencyTracker();
    const result = await runWithLatencySubSpans(
      tracker,
      MEMORY_CONTEXT_PHASE_KEY,
      () =>
        timeLatencySubSpan("stage", "Stage", async () => {
          clock += 25;
          return "ok";
        }),
    );
    expect(result).toBe("ok");
    expect(subPhasesOf(tracker)).toEqual([
      { key: "stage", label: "Stage", ms: 25 },
    ]);
  });

  test("outside a scope both helpers are pass-through no-ops", async () => {
    expect(
      await timeLatencySubSpan("stage", "Stage", () => Promise.resolve(7)),
    ).toBe(7);
    expect(() => recordLatencySubSpan("stage", "Stage", 500)).not.toThrow();
  });

  test("spans under the floor are dropped; the floor itself records", () => {
    const tracker = new TurnLatencyTracker();
    runWithLatencySubSpans(tracker, MEMORY_CONTEXT_PHASE_KEY, () => {
      recordLatencySubSpan("under", "Under", MIN_SUB_SPAN_MS - 1);
      recordLatencySubSpan("at", "At", MIN_SUB_SPAN_MS);
    });
    expect(subPhasesOf(tracker)).toEqual([
      { key: "at", label: "At", ms: MIN_SUB_SPAN_MS },
    ]);
  });

  test("a throwing stage records its span and rethrows", async () => {
    const tracker = new TurnLatencyTracker();
    await runWithLatencySubSpans(
      tracker,
      MEMORY_CONTEXT_PHASE_KEY,
      async () => {
        await expect(
          timeLatencySubSpan("boom", "Boom", async () => {
            clock += 30;
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
      },
    );
    expect(subPhasesOf(tracker)).toEqual([
      { key: "boom", label: "Boom", ms: 30 },
    ]);
  });

  test("concurrent scopes with distinct trackers stay isolated", async () => {
    const a = new TurnLatencyTracker();
    const b = new TurnLatencyTracker();
    await Promise.all([
      runWithLatencySubSpans(a, MEMORY_CONTEXT_PHASE_KEY, () =>
        timeLatencySubSpan("a-span", "A", async () => {
          await Promise.resolve();
          clock += 20;
        }),
      ),
      runWithLatencySubSpans(b, MEMORY_CONTEXT_PHASE_KEY, () =>
        timeLatencySubSpan("b-span", "B", async () => {
          await Promise.resolve();
          clock += 20;
        }),
      ),
    ]);
    expect(subPhasesOf(a)?.map((s) => s.key)).toEqual(["a-span"]);
    expect(subPhasesOf(b)?.map((s) => s.key)).toEqual(["b-span"]);
  });
});
