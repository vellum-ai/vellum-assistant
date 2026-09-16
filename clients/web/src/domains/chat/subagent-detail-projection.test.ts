/**
 * Tests for the incremental detail-map projector
 * (`createIncrementalDetailProjection`).
 *
 * The core safety net is the **no-drift property test**: it drives the projector
 * one store-mutation at a time (append vs text-coalesce mutate-last, exactly as
 * `subagent-store.receiveEvent` does) and asserts the incremental `Map` always
 * deep-equals a full `buildSubagentStepDetails` rebuild, so the O(Δ) replay can
 * never diverge from the O(n) source of truth for thinking payloads keyed by
 * event id.
 */

import { describe, expect, test } from "bun:test";

import { createIncrementalDetailProjection } from "@/domains/chat/subagent-detail-projection";
import {
  applyDetailEvent,
  buildSubagentStepDetails,
} from "@/domains/chat/hooks/use-subagent-card-data";
import {
  NOW,
  appendEvent,
  applyMutation as applyMutationShared,
  coalesceText as coalesceTextShared,
  createMakeEvent,
  generateStream as generateStreamShared,
  type Mutation,
} from "@/domains/chat/subagent-projection-test-fixtures";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";
import type { ToolDetailPayload } from "@/stores/viewer-store";

let eventSeq = 0;
function nextEventId(): string {
  return `de-${eventSeq++}`;
}

const makeEvent = createMakeEvent(nextEventId);

// Bind the shared simulator/generator to this suite's `makeEvent`.
function coalesceText(
  events: SubagentTimelineEvent[],
  delta: string,
  ts: number,
): SubagentTimelineEvent[] {
  return coalesceTextShared(events, delta, ts, makeEvent);
}

function generateStream(seed: number, n: number): Mutation[] {
  return generateStreamShared(seed, n, makeEvent);
}

function applyMutation(
  events: SubagentTimelineEvent[],
  m: Mutation,
): SubagentTimelineEvent[] {
  return applyMutationShared(events, m, makeEvent);
}

/**
 * Stable, order-independent serialization of a detail map for deep comparison:
 * sort by key, then compare key→payload pairs. (`Map` equality in bun's `toEqual`
 * is order-sensitive on insertion; the incremental and full paths build the same
 * payloads but we compare the canonical content, not insertion order.)
 */
function mapToSortedEntries(
  map: Map<string, ToolDetailPayload>,
): Array<[string, ToolDetailPayload]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function expectMapsEqual(
  incremental: Map<string, ToolDetailPayload>,
  full: Map<string, ToolDetailPayload>,
): void {
  expect(mapToSortedEntries(incremental)).toEqual(mapToSortedEntries(full));
}

// ---------------------------------------------------------------------------
// Per-diff-class unit tests
// ---------------------------------------------------------------------------

describe("createIncrementalDetailProjection — per-diff-class", () => {
  test("first call / empty cache builds via full rebuild", () => {
    const p = createIncrementalDetailProjection();
    const events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "Investigating" }),
    ];
    expectMapsEqual(p.project(events), buildSubagentStepDetails(events));
  });

  test("identity: same array reference returns the cached Map by reference", () => {
    const p = createIncrementalDetailProjection();
    const events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "hi" }),
    ];
    const first = p.project(events);
    const second = p.project(events);
    expect(second).toBe(first);
  });

  test("thinking payload is keyed by the source event id", () => {
    const p = createIncrementalDetailProjection();
    const textEv = makeEvent({ type: "text", content: "deep reasoning here" });
    const events = [textEv];
    const map = p.project(events);
    const payload = map.get(textEv.id);
    expect(payload?.kind).toBe("thinking");
    expect(payload?.toolCallId).toBe(textEv.id);
    expect(payload?.thinkingText).toBe("deep reasoning here");
  });

  test("append-1 text: new thinking payload keyed by event id", () => {
    const p = createIncrementalDetailProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "first" }),
    ];
    p.project(events);
    const second = makeEvent({ type: "text", content: "second" });
    events = appendEvent(events, second);
    const map = p.project(events);
    expectMapsEqual(map, buildSubagentStepDetails(events));
    expect(map.get(second.id)?.thinkingText).toBe("second");
  });

  test("mutate-last thinking payload grows with the full untruncated content", () => {
    const p = createIncrementalDetailProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "short" }),
    ];
    const first = p.project(events);
    const id = events[0]!.id;
    expect(first.get(id)?.thinkingText).toBe("short");
    // Grow past 160 chars — unlike steps, the thinking payload carries the FULL
    // content, so it keeps changing every delta (no clamp shortcut).
    const tail = "x".repeat(300);
    events = coalesceText(events, tail, events[0]!.timestamp);
    const second = p.project(events);
    expectMapsEqual(second, buildSubagentStepDetails(events));
    expect(second.get(id)?.thinkingText).toBe("short" + tail);
  });

  test("full-replace (history hydration) falls back to a full rebuild", () => {
    const p = createIncrementalDetailProjection();
    p.project([makeEvent({ type: "text", content: "live" })]);
    const hydrated: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "hydrated-1" }),
      makeEvent({
        type: "tool_call",
        toolName: "bash",
        toolUseId: "h-1",
        content: "echo",
      }),
    ];
    expectMapsEqual(p.project(hydrated), buildSubagentStepDetails(hydrated));
  });

  test("subagent switch (totally different array) falls back to a full rebuild", () => {
    const p = createIncrementalDetailProjection();
    p.project([
      makeEvent({
        type: "tool_call",
        toolName: "web_search",
        toolUseId: "ws-a",
        input: { query: "a" },
      }),
    ]);
    const other: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "different subagent" }),
      makeEvent({
        type: "tool_call",
        toolName: "web_fetch",
        toolUseId: "wf-b",
        input: { url: "https://x.dev" },
      }),
    ];
    expectMapsEqual(p.project(other), buildSubagentStepDetails(other));
  });

  test("truncation (shorter array) falls back to a full rebuild", () => {
    const p = createIncrementalDetailProjection();
    const full: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "a" }),
      makeEvent({ type: "text", content: "b" }),
    ];
    p.project(full);
    const truncated = full.slice(0, 1);
    expectMapsEqual(p.project(truncated), buildSubagentStepDetails(truncated));
  });

  test("cross-subagent id collision (detail-1 reused) is NOT misclassified as mutate-last", () => {
    // `mapDetailEvents` restarts event ids at `detail-1` for EACH subagent. When
    // the panel is reused across a subagent switch and both subagents have
    // exactly ONE event, the last ids collide on `detail-1`. The previous
    // reasoning must NOT survive into subagent B's map: only id equality would
    // have let it through; the text-coalescing content-shape guards force a full
    // rebuild instead.
    const p = createIncrementalDetailProjection();
    const subagentA: SubagentTimelineEvent[] = [
      {
        id: "detail-1",
        type: "text",
        content: "A reasons about something else",
        timestamp: NOW,
      },
    ];
    p.project(subagentA);
    // Subagent B: a single text event — SAME id `detail-1`, different object.
    const subagentB: SubagentTimelineEvent[] = [
      {
        id: "detail-1",
        type: "text",
        content: "B is thinking",
        timestamp: NOW,
      },
    ];
    const map = p.project(subagentB);
    // Must deep-equal a full rebuild of B, with no stale reasoning from A.
    expectMapsEqual(map, buildSubagentStepDetails(subagentB));
    expect(map.get("detail-1")?.thinkingText).toBe("B is thinking");
  });

  test("tool events contribute no payload: a tool pill opens the call from history", () => {
    const events: SubagentTimelineEvent[] = [
      makeEvent({
        type: "tool_call",
        toolName: "bash",
        toolUseId: "tu-1",
        content: "ls",
      }),
      makeEvent({
        type: "tool_result",
        toolName: "bash",
        toolUseId: "tu-1",
        result: "file-a",
      }),
    ];
    expect(createIncrementalDetailProjection().project(events).size).toBe(0);
  });

  test("genuine text coalescing (same id, text→text, content extends) still takes the incremental path", () => {
    // The positive case: the work-count seam proves the incremental mutate-last
    // path is taken (exactly ONE reducer call to re-derive the grown tail), and
    // the result still deep-equals a full rebuild.
    let calls = 0;
    const counting = (
      payloads: ToolDetailPayload[],
      event: SubagentTimelineEvent,
    ) => {
      calls++;
      applyDetailEvent(payloads, event);
    };
    const p = createIncrementalDetailProjection(counting);
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "Investig" }),
    ];
    p.project(events);
    const callsAfterFirst = calls;
    events = coalesceText(events, "ating the bug", events[0]!.timestamp);
    const map = p.project(events);
    // Incremental path: exactly one more reducer call (re-derive the grown tail),
    // not a full re-walk of every event.
    expect(calls - callsAfterFirst).toBe(1);
    expectMapsEqual(map, buildSubagentStepDetails(events));
  });
});

// ---------------------------------------------------------------------------
// No-drift property test — the core safety net.
// ---------------------------------------------------------------------------

describe("createIncrementalDetailProjection — no-drift property", () => {
  const seeds = [1, 7, 42, 1337, 99999];
  for (const seed of seeds) {
    test(`seed ${seed}: incremental Map deep-equals full rebuild after every mutation (N=300)`, () => {
      const projector = createIncrementalDetailProjection();
      const mutations = generateStream(seed, 300);
      let events: SubagentTimelineEvent[] = [];
      // Prime with the empty array.
      projector.project(events);

      for (let i = 0; i < mutations.length; i++) {
        events = applyMutation(events, mutations[i]!);
        const incremental = projector.project(events);
        const full = buildSubagentStepDetails(events);
        expectMapsEqual(incremental, full);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Incremental-work guard — reducer invocations must be ~O(N), not O(N²).
// ---------------------------------------------------------------------------

describe("createIncrementalDetailProjection — incremental-work guard", () => {
  function countReducerCalls(n: number): number {
    let calls = 0;
    const counting = (
      payloads: ToolDetailPayload[],
      event: SubagentTimelineEvent,
    ) => {
      calls++;
      applyDetailEvent(payloads, event);
    };
    const projector = createIncrementalDetailProjection(counting);
    const mutations = generateStream(2024, n);

    let events: SubagentTimelineEvent[] = [];
    projector.project(events);
    for (const m of mutations) {
      events = applyMutation(events, m);
      projector.project(events);
    }
    return calls;
  }

  for (const n of [50, 150, 300]) {
    test(`N=${n}: reducer invocations are ~linear (≤ N), not O(N²)`, () => {
      const calls = countReducerCalls(n);
      // Each store mutation replays at most ONE event through the reducer
      // (append-1 → 1 call; mutate-last → exactly 1 re-derive call). So the
      // total is bounded by the number of mutations, far below N² for large N.
      expect(calls).toBeLessThanOrEqual(n);
      // Sanity: O(N²) would be ~N*N/2; assert we're nowhere near it.
      expect(calls).toBeLessThan((n * n) / 4);
    });
  }

  test("reducer call count grows linearly across N ∈ {50,150,300}", () => {
    const c50 = countReducerCalls(50);
    const c150 = countReducerCalls(150);
    const c300 = countReducerCalls(300);
    // Linear growth: tripling N roughly triples the work (within a small band).
    // Quadratic growth would make c300/c50 ≈ 36, not ≈ 6.
    expect(c300 / Math.max(c50, 1)).toBeLessThan(12);
    expect(c150).toBeGreaterThan(c50);
    expect(c300).toBeGreaterThan(c150);
  });
});
