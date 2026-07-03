/**
 * Tests for the shared diff classifier (`classifyEventsDiff`) extracted from the
 * two incremental subagent projectors. Each `kind` is covered, including the two
 * cases that MUST fall back to a full rebuild: the cross-subagent `detail-1`
 * id-collision (single-event subagent switch that would be misclassified as
 * mutate-last by id alone) and a full-replace. The projectors' own no-drift
 * property tests are the end-to-end safety net; these pin the classifier itself.
 */

import { describe, expect, test } from "bun:test";

import { classifyEventsDiff } from "@/domains/chat/subagent-projection-diff";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

let seq = 0;
function textEvent(content: string): SubagentTimelineEvent {
  return { id: `e-${seq++}`, type: "text", content, timestamp: NOW };
}
function toolCallEvent(toolUseId: string): SubagentTimelineEvent {
  return {
    id: `e-${seq++}`,
    type: "tool_call",
    content: "ls",
    toolName: "bash",
    toolUseId,
    timestamp: NOW,
  };
}

describe("classifyEventsDiff", () => {
  test("identity: same array reference", () => {
    const events = [textEvent("hi")];
    expect(classifyEventsDiff(events, events)).toEqual({ kind: "identity" });
  });

  test("first: no previous array (null cache)", () => {
    const events = [textEvent("hi")];
    expect(classifyEventsDiff(null, events)).toEqual({ kind: "first" });
  });

  test("first: from an empty cache, a non-empty array is still a first build when prev is null", () => {
    expect(classifyEventsDiff(null, [])).toEqual({ kind: "first" });
  });

  test("append: same prefix, one new event at the tail — `from` is prevEvents.length", () => {
    const a = textEvent("first");
    const prev = [a];
    const events = [a, textEvent("second")];
    expect(classifyEventsDiff(prev, events)).toEqual({ kind: "append", from: 1 });
  });

  test("append: multiple new events at the tail", () => {
    const a = textEvent("a");
    const b = toolCallEvent("tu-1");
    const prev = [a, b];
    const events = [a, b, textEvent("c"), toolCallEvent("tu-2")];
    expect(classifyEventsDiff(prev, events)).toEqual({ kind: "append", from: 2 });
  });

  test("append: growing from an empty previous array", () => {
    const events = [textEvent("a")];
    expect(classifyEventsDiff([], events)).toEqual({ kind: "append", from: 0 });
  });

  test("append rejected when the shared-prefix boundary references differ → fallback", () => {
    // Longer array, but `events[0]` is a different object (no shared prefix):
    // a full-replace whose new array merely happens to be longer.
    const prev = [textEvent("a")];
    const events = [textEvent("a"), textEvent("b")];
    expect(classifyEventsDiff(prev, events)).toEqual({ kind: "fallback" });
  });

  test("mutate-last: genuine text coalescing (same id, text→text, strict content extension)", () => {
    const a = textEvent("Investig");
    const prev = [a];
    // Same id, longer content that strictly extends the old — the store's
    // text-delta coalescing shape.
    const grown: SubagentTimelineEvent = { ...a, content: "Investigating" };
    expect(classifyEventsDiff(prev, [grown])).toEqual({ kind: "mutate-last" });
  });

  test("mutate-last: coalescing with a shared earlier prefix", () => {
    const head = toolCallEvent("tu-1");
    const a = textEvent("Inv");
    const prev = [head, a];
    const grown: SubagentTimelineEvent = { ...a, content: "Investigating" };
    expect(classifyEventsDiff(prev, [head, grown])).toEqual({
      kind: "mutate-last",
    });
  });

  test("fallback: cross-subagent detail-1 id collision is NOT mutate-last", () => {
    // `mapDetailEvents` restarts ids at `detail-1` per subagent. Two
    // single-event subagents collide on `id === "detail-1"`, but the last events
    // differ in type/content, so the content-shape guards force a fallback (a
    // full rebuild), NOT a mutate-last that would carry a stale entry over.
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
    const subagentB: SubagentTimelineEvent[] = [
      { id: "detail-1", type: "text", content: "B is thinking", timestamp: NOW },
    ];
    expect(classifyEventsDiff(subagentA, subagentB)).toEqual({
      kind: "fallback",
    });
  });

  test("fallback: same id + same length but content shrinks (not a strict extension)", () => {
    const a = textEvent("Investigating");
    const prev = [a];
    const shrunk: SubagentTimelineEvent = { ...a, content: "Inv" };
    expect(classifyEventsDiff(prev, [shrunk])).toEqual({ kind: "fallback" });
  });

  test("fallback: full-replace (wholesale array swap, no shared prefix)", () => {
    const prev = [textEvent("live")];
    const hydrated = [textEvent("hydrated-1"), toolCallEvent("h-1")];
    expect(classifyEventsDiff(prev, hydrated)).toEqual({ kind: "fallback" });
  });

  test("fallback: truncation (shorter array)", () => {
    const a = textEvent("a");
    const b = textEvent("b");
    const prev = [a, b];
    expect(classifyEventsDiff(prev, [a])).toEqual({ kind: "fallback" });
  });
});
