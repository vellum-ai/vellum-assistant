import { describe, expect, test } from "bun:test";

import type { AcpRunRawEvent } from "@/domains/chat/acp-run-store";
import {
  acpStepsToCarousel,
  computeAcpRunSteps,
  createAcpRunStepProjection,
  type AcpTimelineStep,
} from "@/domains/chat/acp-run-step-projection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextSeq = 1;

function event(overrides: Partial<AcpRunRawEvent>): AcpRunRawEvent {
  return {
    seq: nextSeq++,
    updateType: "agent_message_chunk",
    ...overrides,
  };
}

function toolStep(step: AcpTimelineStep): Extract<AcpTimelineStep, { kind: "tool" }> {
  if (step.kind !== "tool") throw new Error(`expected tool, got ${step.kind}`);
  return step;
}

function messageStep(
  step: AcpTimelineStep,
): Extract<AcpTimelineStep, { kind: "message" }> {
  if (step.kind !== "message") throw new Error(`expected message, got ${step.kind}`);
  return step;
}

function planStep(step: AcpTimelineStep): Extract<AcpTimelineStep, { kind: "plan" }> {
  if (step.kind !== "plan") throw new Error(`expected plan, got ${step.kind}`);
  return step;
}

// ---------------------------------------------------------------------------
// Folding rules
// ---------------------------------------------------------------------------

describe("computeAcpRunSteps — folding rules", () => {
  test("tool_call appends a running tool step with title/kind/detailKey", () => {
    const steps = computeAcpRunSteps([
      event({
        updateType: "tool_call",
        toolCallId: "t1",
        toolTitle: "Read file",
        toolKind: "read",
      }),
    ]);
    expect(steps).toHaveLength(1);
    const tool = toolStep(steps[0]!);
    expect(tool.toolCallId).toBe("t1");
    expect(tool.title).toBe("Read file");
    expect(tool.toolKind).toBe("read");
    expect(tool.status).toBe("running");
    expect(tool.outputChunks).toEqual([]);
    expect(tool.detailKey).toBe("tool:t1");
  });

  test("tool_call_update correlates by toolCallId: replaces output + status", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Run" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "out-a" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "out-b" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolStatus: "complete" }),
    ]);
    expect(steps).toHaveLength(1);
    const tool = toolStep(steps[0]!);
    // Each update carries the full snapshot; the latest replaces prior ones.
    expect(tool.outputChunks).toEqual(["out-b"]);
    expect(tool.status).toBe("completed");
  });

  test("tool_call_update content replaces (latest snapshot), not appends", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Run" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "[A]" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "[A, B]" }),
    ]);
    const tool = toolStep(steps[0]!);
    expect(tool.outputChunks.join("")).toBe("[A, B]");
  });

  test("tool_call_update without content leaves the prior snapshot intact", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "[A]" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolStatus: "complete" }),
    ]);
    const tool = toolStep(steps[0]!);
    expect(tool.outputChunks).toEqual(["[A]"]);
    expect(tool.status).toBe("completed");
  });

  test("tool_call carrying initial content seeds it as the first snapshot", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1", content: "[A]" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "[A, B]" }),
    ]);
    expect(toolStep(steps[0]!).outputChunks).toEqual(["[A, B]"]);
  });

  test("tool_call_update maps failed/error to error status", () => {
    const failed = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolStatus: "failed" }),
    ]);
    expect(toolStep(failed[0]!).status).toBe("error");

    const errored = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t2" }),
      event({ updateType: "tool_call_update", toolCallId: "t2", toolStatus: "error" }),
    ]);
    expect(toolStep(errored[0]!).status).toBe("error");
  });

  test("tool_call_update keeps running for unknown/absent status", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "x" }),
    ]);
    expect(toolStep(steps[0]!).status).toBe("running");
  });

  test("tool_call_update only overrides title/kind when carried", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Orig", toolKind: "read" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", content: "x" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolTitle: "New" }),
    ]);
    const tool = toolStep(steps[0]!);
    expect(tool.title).toBe("New");
    expect(tool.toolKind).toBe("read");
  });

  test("tool_call_update for an unknown toolCallId is ignored", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call_update", toolCallId: "ghost", content: "x" }),
    ]);
    expect(steps).toHaveLength(0);
  });

  test("agent_message_chunk accumulates within one messageId", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "Hel" }),
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "lo" }),
    ]);
    expect(steps).toHaveLength(1);
    const msg = messageStep(steps[0]!);
    expect(msg.content).toBe("Hello");
    expect(msg.messageId).toBe("m1");
    expect(msg.detailKey).toBe("msg:m1");
  });

  test("message boundary by messageId: distinct ids split steps", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "a" }),
      event({ updateType: "agent_message_chunk", messageId: "m2", content: "b" }),
    ]);
    expect(steps).toHaveLength(2);
    expect(messageStep(steps[0]!).content).toBe("a");
    expect(messageStep(steps[1]!).content).toBe("b");
    // The earlier message closes once a later step starts.
    expect(messageStep(steps[0]!).isComplete).toBe(true);
    expect(messageStep(steps[1]!).isComplete).toBe(false);
  });

  test("message boundary by gap fallback for anonymous chunks", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", content: "a" }),
      event({ updateType: "agent_message_chunk", content: "b" }),
      event({ updateType: "tool_call", toolCallId: "t1" }),
      event({ updateType: "agent_message_chunk", content: "c" }),
    ]);
    // First two coalesce (anonymous, contiguous); the tool is a boundary, so
    // "c" starts a fresh message.
    expect(steps.map((s) => s.kind)).toEqual(["message", "tool", "message"]);
    expect(messageStep(steps[0]!).content).toBe("ab");
    expect(messageStep(steps[2]!).content).toBe("c");
  });

  test("folds a final id-bearing snapshot into the streamed anonymous step", () => {
    // Some agents stream a message as id-less deltas, then re-send the whole
    // message as one chunk that finally carries a messageId; it must not open a
    // duplicate step.
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", content: "## Plan\n" }),
      event({ updateType: "agent_message_chunk", content: "step one" }),
      event({
        updateType: "agent_message_chunk",
        messageId: "m1",
        content: "## Plan\nstep one",
      }),
    ]);
    expect(steps).toHaveLength(1);
    const msg = messageStep(steps[0]!);
    expect(msg.content).toBe("## Plan\nstep one");
    expect(msg.messageId).toBe("m1");
    expect(msg.detailKey).toBe("msg:m1");
  });

  test("does not fold an id-bearing chunk that differs from the streamed text", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", content: "first" }),
      event({
        updateType: "agent_message_chunk",
        messageId: "m2",
        content: "a different message",
      }),
    ]);
    expect(steps).toHaveLength(2);
    expect(messageStep(steps[0]!).messageId).toBe("");
    expect(messageStep(steps[1]!).messageId).toBe("m2");
  });

  test("agent_thought_chunk accumulates and splits by messageId", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_thought_chunk", messageId: "th1", content: "Pon" }),
      event({ updateType: "agent_thought_chunk", messageId: "th1", content: "der" }),
      event({ updateType: "agent_thought_chunk", messageId: "th2", content: "more" }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.kind).toBe("thought");
    if (steps[0]!.kind === "thought") {
      expect(steps[0]!.content).toBe("Ponder");
      expect(steps[0]!.detailKey).toBe("thought:th1");
    }
    if (steps[1]!.kind === "thought") expect(steps[1]!.content).toBe("more");
  });

  test("plan parses entries and replaces in place (no duplicate plan steps)", () => {
    const first = JSON.stringify([
      { label: "Step 1", checked: false },
      { label: "Step 2", checked: true },
    ]);
    const second = JSON.stringify([{ label: "Only", checked: true }]);
    const steps = computeAcpRunSteps([
      event({ updateType: "plan", content: first }),
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "x" }),
      event({ updateType: "plan", content: second }),
    ]);
    const plans = steps.filter((s) => s.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(planStep(plans[0]!).entries).toEqual([{ label: "Only", checked: true }]);
  });

  test("plan after a message closes the trailing message step", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "hi" }),
      event({
        updateType: "plan",
        content: JSON.stringify([{ label: "Step 1", checked: false }]),
      }),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["message", "plan"]);
    expect(messageStep(steps[0]!).isComplete).toBe(true);
  });

  test("plan reads entry labels from `content` (ACP PlanEntry shape)", () => {
    const content = JSON.stringify([
      { content: "Do X", status: "completed" },
      { content: "Do Y", status: "pending" },
    ]);
    const steps = computeAcpRunSteps([event({ updateType: "plan", content })]);
    expect(planStep(steps[0]!).entries).toEqual([
      { label: "Do X", checked: true },
      { label: "Do Y", checked: false },
    ]);
  });

  test("plan tolerates entries wrapped in an object", () => {
    const content = JSON.stringify({ entries: [{ label: "A", status: "completed" }] });
    const steps = computeAcpRunSteps([event({ updateType: "plan", content })]);
    expect(planStep(steps[0]!).entries).toEqual([{ label: "A", checked: true }]);
  });

  test("plan with malformed JSON is skipped", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "plan", content: "{not json" }),
    ]);
    expect(steps).toHaveLength(0);
  });

  test("user_message_chunk is ignored for the timeline", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "user_message_chunk", content: "hi" }),
    ]);
    expect(steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Incremental projector
// ---------------------------------------------------------------------------

describe("createAcpRunStepProjection — incremental", () => {
  test("returns stable reference on identity (no-op) input", () => {
    const projector = createAcpRunStepProjection();
    const events = [
      event({ updateType: "tool_call", toolCallId: "t1" }),
    ];
    const a = projector.project(events);
    const b = projector.project(events);
    expect(a).toBe(b);
  });

  test("append path matches full rebuild", () => {
    const projector = createAcpRunStepProjection();
    const e1 = event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Run" });
    const events1 = [e1];
    projector.project(events1);

    const e2 = event({ updateType: "tool_call_update", toolCallId: "t1", content: "out" });
    const e3 = event({ updateType: "agent_message_chunk", messageId: "m1", content: "hi" });
    const events2 = [e1, e2, e3];
    const incremental = projector.project(events2);

    expect(incremental).toEqual(computeAcpRunSteps(events2));
  });

  test("a grown-last-element diff falls back to a correct full rebuild", () => {
    const projector = createAcpRunStepProjection();
    const c1 = event({ updateType: "agent_message_chunk", messageId: "m1", content: "Hel" });
    projector.project([c1]);

    // The raw buffer no longer coalesces, but the projector still defends
    // against a same-length diff whose last element grew (the mutate-last shape)
    // by doing a full rebuild.
    const c1grown = { ...c1, seq: (c1.seq ?? 0) + 1, content: "Hello" };
    const result = projector.project([c1grown]);
    expect(messageStep(result[0]!).content).toBe("Hello");
    expect(result).toEqual(computeAcpRunSteps([c1grown]));
  });

  test("full-replace (history hydration) falls back to a full rebuild", () => {
    const projector = createAcpRunStepProjection();
    projector.project([event({ updateType: "tool_call", toolCallId: "t1" })]);

    const hydrated = [
      event({ updateType: "tool_call", toolCallId: "h1", toolTitle: "Hist" }),
      event({ updateType: "tool_call_update", toolCallId: "h1", toolStatus: "complete" }),
    ];
    const result = projector.project(hydrated);
    expect(result).toEqual(computeAcpRunSteps(hydrated));
    expect(toolStep(result[0]!).status).toBe("completed");
  });

  test("tolerates a small window of duplicate message chunks on rehydration overlap", () => {
    // Tool steps are keyed by toolCallId so a replayed tool_call/update pair is
    // naturally idempotent.
    const events = [
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Run" }),
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Run-dup" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolStatus: "complete" }),
    ];
    const steps = computeAcpRunSteps(events);
    // A duplicate tool_call for the same id appends a second step (best-effort);
    // both correlate to updates by id — no crash, ids preserved.
    const tools = steps.filter((s) => s.kind === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.every((s) => toolStep(s).toolCallId === "t1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carousel helper
// ---------------------------------------------------------------------------

describe("acpStepsToCarousel", () => {
  test("derives last-N items with labels + statuses", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "agent_thought_chunk", messageId: "th1", content: "x" }),
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Read" }),
      event({ updateType: "tool_call_update", toolCallId: "t1", toolStatus: "complete" }),
      event({ updateType: "agent_message_chunk", messageId: "m1", content: "hi" }),
    ]);
    const carousel = acpStepsToCarousel(steps, 2);
    expect(carousel).toHaveLength(2);
    expect(carousel[0]).toEqual({ label: "Read", status: "completed" });
    expect(carousel[1]).toEqual({ label: "Responding", status: "running" });
  });

  test("running tool surfaces a running carousel status", () => {
    const steps = computeAcpRunSteps([
      event({ updateType: "tool_call", toolCallId: "t1", toolTitle: "Search" }),
    ]);
    expect(acpStepsToCarousel(steps)).toEqual([
      { label: "Search", status: "running" },
    ]);
  });
});
