/**
 * Tests for the incremental step projector (`createIncrementalStepProjection`).
 *
 * The core safety net is the **no-drift property test**: it drives the projector
 * one store-mutation at a time (append vs text-coalesce mutate-last, exactly as
 * `subagent-store.receiveEvent` does) and asserts the incremental output always
 * deep-equals a full `computeSubagentSteps` rebuild — so the O(Δ) replay can
 * never diverge from the O(n) source of truth.
 */

import { describe, expect, test } from "bun:test";

import { createIncrementalStepProjection } from "@/domains/chat/subagent-step-projection";
import {
  applyTimelineEvent,
  computeSubagentSteps,
  type ToolCallCardStep,
  type ToolMeta,
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

let eventSeq = 0;
function nextEventId(): string {
  return `te-${eventSeq++}`;
}

const makeEvent = createMakeEvent(nextEventId);

// Bind the shared simulator/generator to this suite's `makeEvent` so each test
// file keeps its own id sequence. The step suite emits BARE error rows when an
// error closes a tool (no tool metadata) — the default `generateStream` shape.
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

// ---------------------------------------------------------------------------
// Per-diff-class unit tests
// ---------------------------------------------------------------------------

describe("createIncrementalStepProjection — per-diff-class", () => {
  test("first call / empty cache builds via full rebuild", () => {
    const p = createIncrementalStepProjection();
    const events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "Investigating" }),
    ];
    expect(p.project(events)).toEqual(computeSubagentSteps(events));
  });

  test("identity: same array reference returns the cached result unchanged", () => {
    const p = createIncrementalStepProjection();
    const events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "hi" }),
    ];
    const first = p.project(events);
    const second = p.project(events);
    // The projector returns the cached ARRAY references unchanged on identity
    // (the `useSubagentSteps` hook layers wrapper-object stability on top).
    expect(second.steps).toBe(first.steps);
    expect(second.toolMeta).toBe(first.toolMeta);
  });

  test("append-1 text: new tail thinking step", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "first" }),
    ];
    p.project(events);
    events = appendEvent(events, makeEvent({ type: "text", content: "second" }));
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    expect(out.steps).toHaveLength(2);
  });

  test("append-1 tool_call: new in-flight tool step", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "thinking" }),
    ];
    p.project(events);
    events = appendEvent(
      events,
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "tu-1", content: "ls" }),
    );
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    const last = out.steps[out.steps.length - 1]!;
    expect(last.kind).toBe("tool");
    if (last.kind === "tool") expect(last.status).toBe("running");
  });

  test("append-1 tool_result closes an EARLIER in-flight tool (not the tail)", () => {
    const p = createIncrementalStepProjection();
    // tool_call, then a trailing text event, then the tool_result lands — so the
    // result must close the tool at an earlier index, exercising the
    // append-MOSTLY path through the real reducer.
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "tu-1", content: "ls", timestamp: NOW }),
      makeEvent({ type: "text", content: "waiting" }, NOW + 100),
    ];
    p.project(events);
    events = appendEvent(
      events,
      makeEvent({ type: "tool_result", toolName: "bash", toolUseId: "tu-1", content: "ok", timestamp: NOW + 2500 }),
    );
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    const toolStep = out.steps.find((s) => s.kind === "tool")!;
    expect(toolStep.kind).toBe("tool");
    if (toolStep.kind === "tool") expect(toolStep.status).toBe("completed");
  });

  test("append-1 error closes in-flight tool + appends a tool_error step", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "tu-1", content: "rm -rf /", timestamp: NOW }),
    ];
    p.project(events);
    events = appendEvent(
      events,
      makeEvent({ type: "error", content: "permission denied", timestamp: NOW + 500 }),
    );
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    const toolStep = out.steps.find((s) => s.kind === "tool")!;
    if (toolStep.kind === "tool") expect(toolStep.status).toBe("error");
    expect(out.steps[out.steps.length - 1]!.kind).toBe("tool_error");
  });

  test("mutate-last under the 160-char clamp: new tail identity, content grows", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "short" }),
    ];
    const first = p.project(events);
    const firstTail = first.steps[0]!;
    // Grow the text but stay well under 160 chars.
    events = coalesceText(events, " more text", events[0]!.timestamp);
    const second = p.project(events);
    expect(second).toEqual(computeSubagentSteps(events));
    // A new tail step (preview changed), so the array is a fresh reference.
    expect(second.steps).not.toBe(first.steps);
    const secondTail = second.steps[0]!;
    if (firstTail.kind === "thinking" && secondTail.kind === "thinking") {
      expect(secondTail.text.length).toBeGreaterThan(firstTail.text.length);
    }
  });

  test("mutate-last PAST the clamp: tail identity preserved (same steps reference)", () => {
    const p = createIncrementalStepProjection();
    // Seed with content already well past 160 chars so the preview is clamped.
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "y".repeat(300) }),
    ];
    const a = p.project(events);
    // Append more identical chars — the clamped 160-char preview is unchanged.
    events = coalesceText(events, "y".repeat(50), events[0]!.timestamp);
    const b = p.project(events);
    expect(b.steps).toBe(a.steps);
    expect(b.toolMeta).toBe(a.toolMeta);
    // Still correct vs the full rebuild.
    expect(b.steps).toEqual(computeSubagentSteps(events).steps);
  });

  test("mutate-last that grows past the clamp from under it: still deep-equals rebuild", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "z".repeat(100) }),
    ];
    p.project(events);
    events = coalesceText(events, "z".repeat(200), events[0]!.timestamp);
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
  });

  test("full-replace (history hydration) falls back to a full rebuild", () => {
    const p = createIncrementalStepProjection();
    p.project([makeEvent({ type: "text", content: "live" })]);
    // A wholesale swap — entirely new array, no shared prefix.
    const hydrated: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "hydrated-1" }),
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "h-1", content: "echo" }),
    ];
    const out = p.project(hydrated);
    expect(out).toEqual(computeSubagentSteps(hydrated));
  });

  test("subagent switch (totally different array) falls back to a full rebuild", () => {
    const p = createIncrementalStepProjection();
    p.project([
      makeEvent({ type: "tool_call", toolName: "web_search", toolUseId: "ws-a", input: { query: "a" } }),
    ]);
    const other: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "different subagent" }),
      makeEvent({ type: "tool_call", toolName: "web_fetch", toolUseId: "wf-b", input: { url: "https://x.dev" } }),
    ];
    const out = p.project(other);
    expect(out).toEqual(computeSubagentSteps(other));
  });

  test("truncation (shorter array) falls back to a full rebuild", () => {
    const p = createIncrementalStepProjection();
    const full: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "a" }),
      makeEvent({ type: "text", content: "b" }),
    ];
    p.project(full);
    const truncated = full.slice(0, 1);
    const out = p.project(truncated);
    expect(out).toEqual(computeSubagentSteps(truncated));
  });

  test("parallel same-name tool calls: result closes the correct match index", () => {
    const p = createIncrementalStepProjection();
    // Two concurrent bash calls; the result for tu-2 must close the SECOND, not
    // the first — exercises `findMatchingInFlightToolIndex` through the append.
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "tu-1", content: "ls", timestamp: NOW }),
      makeEvent({ type: "tool_call", toolName: "bash", toolUseId: "tu-2", content: "pwd", timestamp: NOW + 100 }),
    ];
    p.project(events);
    events = appendEvent(
      events,
      makeEvent({ type: "tool_result", toolName: "bash", toolUseId: "tu-2", content: "/home", timestamp: NOW + 1500 }),
    );
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    const toolSteps = out.steps.filter((s) => s.kind === "tool");
    // First still running, second completed.
    if (toolSteps[0]!.kind === "tool") expect(toolSteps[0]!.status).toBe("running");
    if (toolSteps[1]!.kind === "tool") expect(toolSteps[1]!.status).toBe("completed");
  });

  test("cross-subagent id collision (detail-1 reused) is NOT misclassified as mutate-last", () => {
    // `mapDetailEvents` restarts event ids at `detail-1` for EACH subagent. When
    // the panel is reused across a subagent switch and both subagents have
    // exactly ONE event, the last ids collide on `detail-1`. The previous (tool)
    // step must NOT survive into subagent B's steps — only id equality would have
    // let it through; the text-coalescing content-shape guards force a full
    // rebuild instead.
    const p = createIncrementalStepProjection();
    // Subagent A: a single tool_call (web payload).
    const subagentA: SubagentTimelineEvent[] = [
      {
        id: "detail-1",
        type: "tool_call",
        content: "ls",
        toolName: "bash",
        toolUseId: "tu-a",
        timestamp: NOW,
      },
    ];
    p.project(subagentA);
    // Subagent B: a single text event — SAME id `detail-1`, different object.
    const subagentB: SubagentTimelineEvent[] = [
      { id: "detail-1", type: "text", content: "B is thinking", timestamp: NOW },
    ];
    const out = p.project(subagentB);
    // Must deep-equal a full rebuild of B — no stale tool step from A.
    expect(out).toEqual(computeSubagentSteps(subagentB));
    expect(out.steps.some((s) => s.kind === "tool")).toBe(false);
  });

  test("genuine text coalescing (same id, text→text, content extends) still takes the incremental path", () => {
    // The positive case: the work-count seam proves the incremental mutate-last
    // path is taken (exactly ONE reducer call to re-derive the grown tail), and
    // the result still deep-equals a full rebuild.
    let calls = 0;
    const counting = (
      steps: ToolCallCardStep[],
      toolMeta: Array<ToolMeta | undefined>,
      event: SubagentTimelineEvent,
    ) => {
      calls++;
      applyTimelineEvent(steps, toolMeta, event);
    };
    const p = createIncrementalStepProjection(counting);
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "text", content: "Investig" }),
    ];
    p.project(events);
    const callsAfterFirst = calls;
    events = coalesceText(events, "ating the bug", events[0]!.timestamp);
    const out = p.project(events);
    // Incremental path: exactly one more reducer call (re-derive the grown tail),
    // not a full re-walk of every event.
    expect(calls - callsAfterFirst).toBe(1);
    expect(out).toEqual(computeSubagentSteps(events));
  });

  test("web_search result flips the placeholder to 'Searched the web'", () => {
    const p = createIncrementalStepProjection();
    let events: SubagentTimelineEvent[] = [
      makeEvent({ type: "tool_call", toolName: "web_search", toolUseId: "ws-1", input: { query: "vellum" }, timestamp: NOW }),
    ];
    p.project(events);
    events = appendEvent(
      events,
      makeEvent({ type: "tool_result", toolName: "web_search", toolUseId: "ws-1", result: "Vellum\nhttps://vellum.ai", timestamp: NOW + 900 }),
    );
    const out = p.project(events);
    expect(out).toEqual(computeSubagentSteps(events));
    const search = out.steps[0]!;
    if (search.kind === "web_search") expect(search.title).toBe("Searched the web");
  });
});

// ---------------------------------------------------------------------------
// No-drift property test — the core safety net.
// ---------------------------------------------------------------------------

describe("createIncrementalStepProjection — no-drift property", () => {
  const seeds = [1, 7, 42, 1337, 99999];
  for (const seed of seeds) {
    test(`seed ${seed}: incremental deep-equals full rebuild after every mutation (N=300)`, () => {
      const projector = createIncrementalStepProjection();
      const mutations = generateStream(seed, 300);
      let events: SubagentTimelineEvent[] = [];
      // Prime with the empty array.
      projector.project(events);

      for (let i = 0; i < mutations.length; i++) {
        events = applyMutation(events, mutations[i]!);
        const incremental = projector.project(events);
        const full = computeSubagentSteps(events);
        expect(incremental.steps).toEqual(full.steps);
        expect(incremental.toolMeta).toEqual(full.toolMeta);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Incremental-work guard — reducer invocations must be ~O(N), not O(N²).
// ---------------------------------------------------------------------------

describe("createIncrementalStepProjection — incremental-work guard", () => {
  function countReducerCalls(n: number): { calls: number; toolResults: number } {
    let calls = 0;
    const counting = (
      steps: ToolCallCardStep[],
      toolMeta: Array<ToolMeta | undefined>,
      event: SubagentTimelineEvent,
    ) => {
      calls++;
      applyTimelineEvent(steps, toolMeta, event);
    };
    const projector = createIncrementalStepProjection(counting);
    const mutations = generateStream(2024, n);
    const toolResults = mutations.filter(
      (m) => m.kind === "append" && (m.event.type === "tool_result" || m.event.type === "error"),
    ).length;

    let events: SubagentTimelineEvent[] = [];
    projector.project(events);
    for (const m of mutations) {
      events = applyMutation(events, m);
      projector.project(events);
    }
    return { calls, toolResults };
  }

  for (const n of [50, 150, 300]) {
    test(`N=${n}: reducer invocations are ~linear (≤ N + small constant), not O(N²)`, () => {
      const { calls } = countReducerCalls(n);
      // Each store mutation replays at most ONE event through the reducer
      // (append-1 → 1 call; mutate-last → exactly 1 re-derive call). So the
      // total is bounded by the number of mutations, far below N² for large N.
      expect(calls).toBeLessThanOrEqual(n);
      // Sanity: O(N²) would be ~N*N/2; assert we're nowhere near it.
      expect(calls).toBeLessThan((n * n) / 4);
    });
  }

  test("reducer call count grows linearly across N ∈ {50,150,300}", () => {
    const c50 = countReducerCalls(50).calls;
    const c150 = countReducerCalls(150).calls;
    const c300 = countReducerCalls(300).calls;
    // Linear growth: tripling N roughly triples the work (within a small band).
    // Quadratic growth would make c300/c50 ≈ 36, not ≈ 6.
    expect(c300 / Math.max(c50, 1)).toBeLessThan(12);
    expect(c150).toBeGreaterThan(c50);
    expect(c300).toBeGreaterThan(c150);
  });
});
