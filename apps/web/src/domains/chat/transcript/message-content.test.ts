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
  resolveThinkingTiming,
  resolveToolCall,
} from "@/domains/chat/transcript/message-content";

function toolCall(
  overrides: Partial<ChatMessageToolCall> & Pick<ChatMessageToolCall, "id">,
): ChatMessageToolCall {
  return {
    name: "bash",
    input: {},
    completedAt: 1,
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

  test("reads from contentBlocks verbatim when the row carries them", () => {
    // GIVEN a row whose unified blocks hold the reasoning, with stale
    // positional thinkingSegments that should be ignored
    const message = assistant({
      contentBlocks: [
        { type: "thinking", thinking: "first" },
        { type: "text", text: "spacer" },
        { type: "thinking", thinking: "second" },
      ],
      thinkingSegments: ["STALE", "STALE"],
    });

    // WHEN a thinking run references the i-th thinking by contentOrder index
    // THEN the i-th thinking block's text is returned, not the positional array
    expect(resolveThinkingContent(message, ["0", "1"])).toBe("first\nsecond");
    expect(resolveThinkingContent(message, ["1", "9"])).toBe("second");
  });

  test("falls back per index when contentBlocks is shorter than the positional arrays", () => {
    // GIVEN a row produced by merging adjacent assistant rows: the positional
    // thinkingSegments are concatenated (survivor + donor) but contentBlocks
    // carries only the survivor's blocks, so the donor index has no block
    const message = assistant({
      contentBlocks: [{ type: "thinking", thinking: "survivor" }],
      thinkingSegments: ["survivor", "donor"],
    });

    // WHEN the run references both the survivor (covered by a block) and the
    // donor (beyond the blocks list) index
    // THEN the donor reasoning resolves through the positional fallback instead
    // of being silently dropped
    expect(resolveThinkingContent(message, ["0", "1"])).toBe("survivor\ndonor");
  });
});

describe("resolveThinkingTiming", () => {
  test("spans earliest start and latest completion across the referenced blocks", () => {
    /**
     * A thinking run's duration is the wall-clock span of its blocks, so the
     * timing must be the earliest start and latest completion — not the bounds
     * of whichever block happens to be first in the list.
     */

    // GIVEN thinking blocks whose timestamps are out of order
    const message = assistant({
      contentBlocks: [
        { type: "thinking", thinking: "a", startedAt: 300, completedAt: 500 },
        { type: "thinking", thinking: "b", startedAt: 100, completedAt: 250 },
        { type: "thinking", thinking: "c", startedAt: 700, completedAt: 900 },
      ],
    });

    // WHEN the run references a subset of those blocks
    const timing = resolveThinkingTiming(message, ["0", "1"]);

    // THEN the span covers the earliest start and latest completion
    expect(timing).toEqual({ startedAt: 100, completedAt: 500 });
    // AND extending the run to a later block widens the completion bound
    expect(resolveThinkingTiming(message, ["0", "1", "2"])).toEqual({
      startedAt: 100,
      completedAt: 900,
    });
  });

  test("reports only the bounds the blocks actually carry", () => {
    /**
     * Blocks may carry one bound without the other (e.g. a still-streaming run
     * has a start but no completion); the resolver must surface only what's set.
     */

    // GIVEN one block with only a start and one with only a completion
    const message = assistant({
      contentBlocks: [
        { type: "thinking", thinking: "a", startedAt: 100 },
        { type: "thinking", thinking: "b", completedAt: 400 },
      ],
    });

    // WHEN resolving timing over each / both blocks
    // THEN only the bounds that exist are reported
    expect(resolveThinkingTiming(message, ["0"])).toEqual({ startedAt: 100 });
    expect(resolveThinkingTiming(message, ["0", "1"])).toEqual({
      startedAt: 100,
      completedAt: 400,
    });
  });

  test("returns empty timing for rows without contentBlocks (older daemons)", () => {
    /**
     * Positional thinkingSegments carry no timestamps, so a row that predates
     * the unified projection resolves to empty timing and the UI hides the
     * duration — exactly as a tool call with no startedAt does.
     */

    // GIVEN a row that only has positional thinkingSegments
    const message = assistant({ thinkingSegments: ["first", "second"] });

    // WHEN resolving its thinking timing
    // THEN no bounds are reported
    expect(resolveThinkingTiming(message, ["0", "1"])).toEqual({});
  });
});

describe("isSubagentSpawnCall", () => {
  test("matches bare subagent_spawn", () => {
    expect(isSubagentSpawnCall(toolCall({ id: "x", name: "subagent_spawn" }))).toBe(
      true,
    );
  });

  test("matches skill_execute with input.tool === subagent_spawn", () => {
    expect(
      isSubagentSpawnCall(
        toolCall({
          id: "x",
          name: "skill_execute",
          input: { tool: "subagent_spawn" },
        }),
      ),
    ).toBe(true);
  });

  test("does not match other tools or other skill_execute inputs", () => {
    expect(isSubagentSpawnCall(toolCall({ id: "x", name: "bash" }))).toBe(false);
    expect(
      isSubagentSpawnCall(
        toolCall({ id: "x", name: "skill_execute", input: { tool: "other" } }),
      ),
    ).toBe(false);
  });
});

describe("isSuppressedUiTool", () => {
  test("suppresses ui_* tools without pending confirmation", () => {
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_show" }))).toBe(true);
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_update" }))).toBe(true);
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_dismiss" }))).toBe(true);
  });

  test("does not suppress ui_* with a pending confirmation, or non-ui tools", () => {
    expect(
      isSuppressedUiTool(
        toolCall({
          id: "x",
          name: "ui_show",
          pendingConfirmation: { requestId: "req-1" },
        }),
      ),
    ).toBe(false);
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "bash" }))).toBe(false);
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
