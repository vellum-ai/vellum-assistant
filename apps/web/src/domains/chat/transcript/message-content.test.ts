import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import {
  groupMessageActivityRuns,
  isSubagentSpawnCall,
  isSuppressedUiTool,
  isTaskProgressSurface,
  resolveThinkingContent,
  resolveToolCall,
} from "@/domains/chat/transcript/message-content";

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

function surface(data: Record<string, unknown>): Surface {
  return { surfaceId: "s1", surfaceType: "card", data };
}

describe("groupMessageActivityRuns", () => {
  test("merges contiguous thinking + tool runs, broken by text/surface", () => {
    const message = assistant({
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "toolCall", id: "a" },
        { type: "thinking", id: "1" },
        { type: "text", id: "0" },
        { type: "tool", id: "b" },
        { type: "surface", id: "s0" },
        { type: "thinking", id: "2" },
      ],
    });

    expect(groupMessageActivityRuns(message)).toEqual([
      {
        type: "activity",
        items: [
          { kind: "thinking", ids: ["0"] },
          { kind: "tool", id: "a" },
          { kind: "thinking", ids: ["1"] },
        ],
      },
      { type: "text", id: "0" },
      { type: "activity", items: [{ kind: "tool", id: "b" }] },
      { type: "surface", id: "s0" },
      { type: "activity", items: [{ kind: "thinking", ids: ["2"] }] },
    ]);
  });

  test("merges consecutive thinking entries into one thinking item's ids", () => {
    const message = assistant({
      contentOrder: [
        { type: "thinking", id: "0" },
        { type: "thinking", id: "1" },
        { type: "toolCall", id: "a" },
      ],
    });

    expect(groupMessageActivityRuns(message)).toEqual([
      {
        type: "activity",
        items: [
          { kind: "thinking", ids: ["0", "1"] },
          { kind: "tool", id: "a" },
        ],
      },
    ]);
  });

  test("empty / missing contentOrder yields no groups", () => {
    expect(groupMessageActivityRuns(assistant({}))).toEqual([]);
  });
});

describe("resolveToolCall", () => {
  const message = assistant({
    toolCalls: [toolCall({ id: "call-a" }), toolCall({ id: "call-b" })],
  });

  test("finds by id", () => {
    expect(resolveToolCall(message, "call-b")?.id).toBe("call-b");
  });

  test("falls back to positional index", () => {
    expect(resolveToolCall(message, "0")?.id).toBe("call-a");
    expect(resolveToolCall(message, "1")?.id).toBe("call-b");
  });

  test("returns undefined when out of range / unmatched", () => {
    expect(resolveToolCall(message, "9")).toBeUndefined();
    expect(resolveToolCall(message, "nope")).toBeUndefined();
  });
});

describe("resolveThinkingContent", () => {
  test("joins referenced segments with newlines, skipping missing", () => {
    const message = assistant({ thinkingSegments: ["first", "second"] });
    expect(resolveThinkingContent(message, ["0", "1"])).toBe("first\nsecond");
    expect(resolveThinkingContent(message, ["0", "9"])).toBe("first");
    expect(resolveThinkingContent(message, ["nan"])).toBe("");
  });
});

describe("isSubagentSpawnCall", () => {
  test("matches bare subagent_spawn", () => {
    expect(isSubagentSpawnCall(toolCall({ id: "x", toolName: "subagent_spawn" }))).toBe(
      true,
    );
  });

  test("matches skill_execute with input.tool === subagent_spawn", () => {
    expect(
      isSubagentSpawnCall(
        toolCall({
          id: "x",
          toolName: "skill_execute",
          input: { tool: "subagent_spawn" },
        }),
      ),
    ).toBe(true);
  });

  test("does not match other tools or other skill_execute inputs", () => {
    expect(isSubagentSpawnCall(toolCall({ id: "x", toolName: "bash" }))).toBe(false);
    expect(
      isSubagentSpawnCall(
        toolCall({ id: "x", toolName: "skill_execute", input: { tool: "other" } }),
      ),
    ).toBe(false);
  });
});

describe("isSuppressedUiTool", () => {
  test("suppresses ui_* tools without pending confirmation", () => {
    expect(isSuppressedUiTool(toolCall({ id: "x", toolName: "ui_show" }))).toBe(true);
    expect(isSuppressedUiTool(toolCall({ id: "x", toolName: "ui_update" }))).toBe(true);
    expect(isSuppressedUiTool(toolCall({ id: "x", toolName: "ui_dismiss" }))).toBe(true);
  });

  test("does not suppress ui_* with a pending confirmation, or non-ui tools", () => {
    expect(
      isSuppressedUiTool(
        toolCall({
          id: "x",
          toolName: "ui_show",
          pendingConfirmation: { requestId: "req-1" },
        }),
      ),
    ).toBe(false);
    expect(isSuppressedUiTool(toolCall({ id: "x", toolName: "bash" }))).toBe(false);
  });
});

describe("isTaskProgressSurface", () => {
  test("true for task_progress with a non-empty steps array", () => {
    expect(
      isTaskProgressSurface(
        surface({ template: "task_progress", templateData: { steps: [{ id: "1" }] } }),
      ),
    ).toBe(true);
  });

  test("false for empty steps, missing steps, or other templates", () => {
    expect(
      isTaskProgressSurface(
        surface({ template: "task_progress", templateData: { steps: [] } }),
      ),
    ).toBe(false);
    expect(
      isTaskProgressSurface(surface({ template: "task_progress", templateData: {} })),
    ).toBe(false);
    expect(isTaskProgressSurface(surface({ template: "weather_forecast" }))).toBe(false);
  });
});
