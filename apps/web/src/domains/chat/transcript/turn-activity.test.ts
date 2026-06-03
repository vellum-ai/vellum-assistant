import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { activityAnchorId, buildTurnActivity } from "@/domains/chat/transcript/turn-activity";

function toolCall(
  overrides: Partial<ChatMessageToolCall> & Pick<ChatMessageToolCall, "id">,
): ChatMessageToolCall {
  return {
    toolName: "bash",
    input: {},
    status: "completed",
    ...overrides,
  };
}

function assistant(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    ...overrides,
  };
}

describe("activityAnchorId", () => {
  test("formatting is stable for both kinds", () => {
    expect(activityAnchorId("m1", "thinking", "0")).toBe("activity-m1-th-0");
    expect(activityAnchorId("m1", "tool", "tc-abc")).toBe("activity-m1-tc-tc-abc");
  });
});

describe("buildTurnActivity", () => {
  test("interleaved: thinking + two consecutive bash calls → 1 thinking + 1 tool step", () => {
    const message = assistant({
      thinkingSegments: ["reasoning..."],
      textSegments: [],
      toolCalls: [
        toolCall({ id: "call-a" }),
        toolCall({ id: "call-b" }),
      ],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "call-a" },
        { type: "toolCall", id: "call-b" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(2);
    expect(activity.stepCount).toBe(2);
    expect(activity.steps[0]!.kind).toBe("thinking");
    expect(activity.steps[0]!.anchorId).toBe("activity-m1-th-0");
    expect(activity.steps[0]!.title).toBe("Thought process");
    expect(activity.steps[1]!.kind).toBe("tool");
    expect(activity.steps[1]!.anchorId).toBe("activity-m1-tc-call-a");
  });

  test("two non-consecutive tool groups separated by text → 2 tool steps", () => {
    const message = assistant({
      textSegments: ["some text"],
      toolCalls: [
        toolCall({ id: "call-a" }),
        toolCall({ id: "call-b" }),
      ],
      contentOrder: [
        { type: "toolCall", id: "call-a" },
        { type: "text", id: "0" },
        { type: "toolCall", id: "call-b" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(2);
    expect(activity.steps.every((s) => s.kind === "tool")).toBe(true);
    expect(activity.steps[0]!.anchorId).toBe("activity-m1-tc-call-a");
    expect(activity.steps[1]!.anchorId).toBe("activity-m1-tc-call-b");
  });

  test("legacy shape (toolCalls present, no interleaved contentOrder) → 1 tool step anchored on first tool id", () => {
    const message = assistant({
      textSegments: ["answer"],
      toolCalls: [
        toolCall({ id: "call-a" }),
        toolCall({ id: "call-b" }),
      ],
      contentOrder: [{ type: "text", id: "0" }],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(1);
    expect(activity.steps[0]!.kind).toBe("tool");
    expect(activity.steps[0]!.anchorId).toBe("activity-m1-tc-call-a");
  });

  test("subagent-spawn-only group → no tool step", () => {
    const message = assistant({
      toolCalls: [
        toolCall({ id: "spawn-1", toolName: "subagent_spawn" }),
        toolCall({
          id: "spawn-2",
          toolName: "skill_execute",
          input: { tool: "subagent_spawn" },
        }),
      ],
      contentOrder: [
        { type: "toolCall", id: "spawn-1" },
        { type: "toolCall", id: "spawn-2" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(0);
  });

  test("suppressed ui_show group → no tool step", () => {
    const message = assistant({
      toolCalls: [toolCall({ id: "ui-1", toolName: "ui_show" })],
      contentOrder: [{ type: "toolCall", id: "ui-1" }],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(0);
  });

  test("empty thinking segment → no thinking step", () => {
    const message = assistant({
      thinkingSegments: [""],
      toolCalls: [toolCall({ id: "call-a" })],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "call-a" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(1);
    expect(activity.steps[0]!.kind).toBe("tool");
  });

  test("a running call → aggregate state is loading", () => {
    const message = assistant({
      toolCalls: [
        toolCall({ id: "call-a", status: "completed" }),
        toolCall({ id: "call-b", status: "running" }),
      ],
      contentOrder: [
        { type: "toolCall", id: "call-a" },
        { type: "toolCall", id: "call-b" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.state).toBe("loading");
  });

  test("an errored call with no running call → aggregate state is error", () => {
    const message = assistant({
      toolCalls: [
        toolCall({ id: "call-a", status: "completed" }),
        toolCall({ id: "call-b", status: "error" }),
      ],
      contentOrder: [
        { type: "toolCall", id: "call-a" },
        { type: "toolCall", id: "call-b" },
      ],
    });

    const activity = buildTurnActivity(message);
    expect(activity.state).toBe("error");
  });

  test("interleaved: trailing thinking group + isStreaming → that step loading, aggregate loading", () => {
    const message = assistant({
      thinkingSegments: ["reasoning..."],
      toolCalls: [toolCall({ id: "call-a" })],
      contentOrder: [
        { type: "toolCall", id: "call-a" },
        { type: "thinking", id: "0" },
      ],
    });

    const streaming = buildTurnActivity(message, true);
    expect(streaming.steps).toHaveLength(2);
    expect(streaming.steps[0]!.kind).toBe("tool");
    expect(streaming.steps[1]!.kind).toBe("thinking");
    expect(streaming.steps[1]!.state).toBe("loading");
    expect(streaming.state).toBe("loading");

    // Non-streaming (history) keeps the trailing thinking step complete.
    const settled = buildTurnActivity(message);
    expect(settled.steps[1]!.state).toBe("complete");
    expect(settled.state).toBe("complete");
  });

  test("interleaved: trailing tool group + isStreaming → no thinking step flipped (tool state governs)", () => {
    const message = assistant({
      thinkingSegments: ["reasoning..."],
      toolCalls: [toolCall({ id: "call-a", status: "completed" })],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "call-a" },
      ],
    });

    const activity = buildTurnActivity(message, true);
    expect(activity.steps).toHaveLength(2);
    expect(activity.steps[0]!.kind).toBe("thinking");
    expect(activity.steps[0]!.state).toBe("complete");
    expect(activity.steps[1]!.kind).toBe("tool");
    // Last group is a tool group, so nothing is loading; tool state governs.
    expect(activity.state).toBe("complete");
  });

  test("interleaved: non-trailing thinking group stays complete even when streaming", () => {
    const message = assistant({
      thinkingSegments: ["first", "second"],
      toolCalls: [toolCall({ id: "call-a" })],
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "call-a" },
        { type: "thinking", id: "1" },
      ],
    });

    const activity = buildTurnActivity(message, true);
    expect(activity.steps).toHaveLength(3);
    expect(activity.steps[0]!.kind).toBe("thinking");
    expect(activity.steps[0]!.state).toBe("complete");
    expect(activity.steps[2]!.kind).toBe("thinking");
    expect(activity.steps[2]!.state).toBe("loading");
  });

  test("legacy: trailing thinking run + isStreaming → loading", () => {
    const message = assistant({
      thinkingSegments: ["reasoning..."],
      textSegments: [],
      // No interleaved tool calls in contentOrder → legacy branch.
      contentOrder: [{ type: "thinking", id: "0" }],
    });

    const streaming = buildTurnActivity(message, true);
    expect(streaming.steps).toHaveLength(1);
    expect(streaming.steps[0]!.kind).toBe("thinking");
    expect(streaming.steps[0]!.state).toBe("loading");
    expect(streaming.state).toBe("loading");

    const settled = buildTurnActivity(message);
    expect(settled.steps[0]!.state).toBe("complete");
    expect(settled.state).toBe("complete");
  });

  test("legacy: earlier thinking run stays complete when streaming", () => {
    const message = assistant({
      thinkingSegments: ["first", "second"],
      textSegments: ["answer"],
      // text between two thinking runs splits them; no interleaved tool calls.
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "text", id: "0" },
        { type: "thinking", id: "1" },
      ],
    });

    const activity = buildTurnActivity(message, true);
    expect(activity.steps).toHaveLength(2);
    expect(activity.steps[0]!.state).toBe("complete");
    expect(activity.steps[1]!.state).toBe("loading");
  });

  test("non-assistant message → empty TurnActivity", () => {
    const message: DisplayMessage = {
      id: "u1",
      role: "user",
      toolCalls: [toolCall({ id: "call-a" })],
      contentOrder: [{ type: "toolCall", id: "call-a" }],
    };

    const activity = buildTurnActivity(message);
    expect(activity.steps).toHaveLength(0);
    expect(activity.stepCount).toBe(0);
    expect(activity.state).toBe("complete");
    expect(activity.currentStepTitle).toBe("");
    expect(activity.currentStepInfo).toBe("");
  });
});
