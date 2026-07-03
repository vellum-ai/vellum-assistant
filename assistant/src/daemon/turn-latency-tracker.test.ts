import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { TurnLatencyTracker } from "./turn-latency-tracker.js";

// Drive `Date.now()` deterministically so phase durations are exact.
let clock = 0;
const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
afterAll(() => nowSpy.mockRestore());

function phaseMap(
  phases: { key: string; ms: number }[],
): Record<string, number> {
  return Object.fromEntries(phases.map((p) => [p.key, p.ms]));
}

describe("TurnLatencyTracker", () => {
  test("first call serializes the full turn waterfall", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 10;
    t.mark("prompt_hook_start"); // queue = 10
    clock = 110;
    t.mark("prompt_hook_end"); // memory_context = 100
    clock = 120;
    t.mark("tools_resolved"); // setup = 10
    clock = 130;
    t.mark("request_sent"); // request_prep = 10
    clock = 430;
    t.markFirstToken("thinking"); // ttft = 300
    clock = 700;
    t.mark("call_complete"); // generation = 270

    const { breakdown, cursor } = t.serializeSince(0);
    expect(cursor).toBe(7);
    expect(breakdown).not.toBeNull();
    expect(phaseMap(breakdown!.phases)).toEqual({
      queue: 10,
      memory_context: 100,
      setup: 10,
      request_prep: 10,
      ttft: 300,
      generation: 270,
    });
    expect(breakdown!.ttftMs).toBe(300);
    expect(breakdown!.totalToFirstTokenMs).toBe(430);
    expect(breakdown!.providerDurationMs).toBe(570);
    expect(breakdown!.firstTokenKind).toBe("thinking");
  });

  test("second call segments only its own marks via the cursor", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 10;
    t.mark("prompt_hook_start");
    clock = 110;
    t.mark("prompt_hook_end");
    clock = 120;
    t.mark("tools_resolved");
    clock = 130;
    t.mark("request_sent");
    clock = 430;
    t.markFirstToken("thinking");
    clock = 700;
    t.mark("call_complete");
    const first = t.serializeSince(0);

    // Tool-use loop: a second provider call after tool execution.
    clock = 1000;
    t.mark("tools_resolved"); // tool-exec gap from prev call_complete(700) = 300
    clock = 1010;
    t.mark("request_sent"); // request_prep = 10
    clock = 1200;
    t.markFirstToken("text"); // ttft = 190
    clock = 1260;
    t.mark("call_complete"); // generation = 60

    const { breakdown, cursor } = t.serializeSince(first.cursor);
    expect(cursor).toBe(11);
    expect(breakdown!.phases.map((p) => p.key)).toEqual([
      "setup",
      "request_prep",
      "ttft",
      "generation",
    ]);
    expect(phaseMap(breakdown!.phases).setup).toBe(300);
    expect(breakdown!.ttftMs).toBe(190);
    // total-to-first-token is first-call-only (no `turn_start` in this segment).
    expect(breakdown!.totalToFirstTokenMs).toBeUndefined();
    expect(breakdown!.firstTokenKind).toBe("text");
  });

  test("tool-only response (no streamed token) omits ttft", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 5;
    t.mark("prompt_hook_start");
    clock = 55;
    t.mark("prompt_hook_end");
    clock = 60;
    t.mark("tools_resolved");
    clock = 65;
    t.mark("request_sent");
    clock = 200;
    t.mark("call_complete"); // no first_token

    const { breakdown } = t.serializeSince(0);
    expect(breakdown!.ttftMs).toBeUndefined();
    expect(breakdown!.totalToFirstTokenMs).toBeUndefined();
    expect(breakdown!.firstTokenKind).toBeUndefined();
    // generation spans request_sent → call_complete when no token streamed.
    expect(phaseMap(breakdown!.phases).generation).toBe(135);
    expect(breakdown!.providerDurationMs).toBe(135);
  });

  test("a failed first attempt is superseded by the successful retry", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 10;
    t.mark("prompt_hook_start"); // queue = 10
    clock = 110;
    t.mark("prompt_hook_end"); // memory_context = 100
    // First attempt: tools resolved and request sent, then the provider
    // rejects (context overflow) — no first_token, no call_complete.
    clock = 120;
    t.mark("tools_resolved");
    clock = 130;
    t.mark("request_sent");
    // Recovery runs, then the loop re-issues the call.
    clock = 1000;
    t.mark("tools_resolved");
    clock = 1010;
    t.mark("request_sent");
    clock = 1200;
    t.markFirstToken("text");
    clock = 1260;
    t.mark("call_complete");

    const { breakdown } = t.serializeSince(0);
    // ttft / provider-duration reflect ONLY the successful attempt (1010),
    // not the failed attempt's request_sent (130).
    expect(breakdown!.ttftMs).toBe(190);
    expect(breakdown!.providerDurationMs).toBe(250);
    // The failed attempt's per-call marks are gone: no duplicate phases.
    expect(breakdown!.phases.map((p) => p.key)).toEqual([
      "queue",
      "memory_context",
      "setup",
      "request_prep",
      "ttft",
      "generation",
    ]);
    expect(phaseMap(breakdown!.phases).request_prep).toBe(10);
  });

  test("a failed retry mid tool-loop is superseded", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 10;
    t.mark("prompt_hook_start");
    clock = 110;
    t.mark("prompt_hook_end");
    clock = 120;
    t.mark("tools_resolved");
    clock = 130;
    t.mark("request_sent");
    clock = 430;
    t.markFirstToken("thinking");
    clock = 700;
    t.mark("call_complete");
    const first = t.serializeSince(0);

    // Second call fails after streaming a partial token, then retries.
    clock = 1000;
    t.mark("tools_resolved");
    clock = 1010;
    t.mark("request_sent");
    clock = 1100;
    t.markFirstToken("text"); // partial stream before the failure
    clock = 2000;
    t.mark("tools_resolved");
    clock = 2010;
    t.mark("request_sent");
    clock = 2200;
    t.markFirstToken("text");
    clock = 2260;
    t.mark("call_complete");

    const { breakdown } = t.serializeSince(first.cursor);
    // Only the successful retry (2010) drives ttft / provider-duration; the
    // failed attempt's request_sent (1010) and its stray first_token (1100)
    // are dropped.
    expect(breakdown!.ttftMs).toBe(190);
    expect(breakdown!.providerDurationMs).toBe(250);
    expect(breakdown!.firstTokenKind).toBe("text");
    // No duplicate per-call phases from the failed attempt.
    expect(breakdown!.phases.map((p) => p.key)).toEqual([
      "setup",
      "request_prep",
      "ttft",
      "generation",
    ]);
    expect(phaseMap(breakdown!.phases).request_prep).toBe(10);
    expect(breakdown!.totalToFirstTokenMs).toBeUndefined();
  });

  test("no marks serializes to null", () => {
    const t = new TurnLatencyTracker();
    expect(t.serializeSince(0).breakdown).toBeNull();
    expect(t.serializeSince(0).cursor).toBe(0);
  });

  test("a fully-consumed cursor serializes to null", () => {
    const t = new TurnLatencyTracker();
    clock = 0;
    t.mark("turn_start");
    clock = 10;
    t.mark("request_sent");
    clock = 50;
    t.markFirstToken("thinking");
    clock = 90;
    t.mark("call_complete");
    const { cursor } = t.serializeSince(0);
    expect(t.serializeSince(cursor).breakdown).toBeNull();
  });
});
