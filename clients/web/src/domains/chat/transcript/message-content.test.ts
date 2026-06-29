import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import {
  groupContentBlocks,
  isBackgroundBashCall,
  isRunWorkflowCall,
  isSubagentSpawnCall,
  isSuppressedUiTool,
  isTaskProgressSurface,
} from "@/domains/chat/transcript/message-content";
import { extractBgIdFromResult } from "@/domains/chat/transcript/transcript-message-body-shared";

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

function surface(data: Record<string, unknown>): Surface {
  return { surfaceId: "s1", surfaceType: "card", data };
}

describe("groupContentBlocks", () => {
  test("merges contiguous thinking + tool_use runs, broken by text/surface", () => {
    /**
     * A run of thinking + tool_use blocks collapses into one activity group,
     * closed by a text or surface block.
     */

    // GIVEN unified blocks interleaving thinking, tool_use, text and surface
    const blocks: ConversationContentBlock[] = [
      { type: "thinking", thinking: "plan" },
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      { type: "text", text: "answer" },
      { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
      { type: "surface", surface: surface({}) },
    ];

    // WHEN the blocks are grouped
    // THEN thinking + the first tool merge, text and surface pass through, and
    // the trailing tool opens a fresh activity group
    expect(groupContentBlocks(blocks)).toEqual([
      {
        type: "activity",
        items: [
          { type: "thinking", thinking: "plan", startedAt: undefined, completedAt: undefined },
          { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
        ],
      },
      { type: "text", text: "answer" },
      { type: "activity", items: [{ type: "tool_use", toolCall: toolCall({ id: "call-b" }) }] },
      { type: "surface", surface: surface({}) },
    ]);
  });

  test("coalesces consecutive thinking blocks into one item, joining text and widening timing", () => {
    /**
     * Consecutive reasoning blocks render as a single thought process, so they
     * merge into one item whose text is newline-joined and whose timing spans
     * the earliest start and latest completion.
     */

    // GIVEN two consecutive thinking blocks with out-of-order timing
    const blocks: ConversationContentBlock[] = [
      { type: "thinking", thinking: "first", startedAt: 300, completedAt: 500 },
      { type: "thinking", thinking: "second", startedAt: 100, completedAt: 900 },
    ];

    // WHEN the blocks are grouped
    // THEN they collapse into one thinking item with joined text and a widened span
    expect(groupContentBlocks(blocks)).toEqual([
      {
        type: "activity",
        items: [
          {
            type: "thinking",
            thinking: "first\nsecond",
            startedAt: 100,
            completedAt: 900,
          },
        ],
      },
    ]);
  });

  test("skips attachment blocks and narrows out tool_use blocks missing an id", () => {
    /**
     * Attachments render in their own region, not inline, so attachment blocks
     * are dropped from the walk. Every tool_use block carries an id by the time
     * it reaches render (daemon-guaranteed, ingest-synthesized); the id guard
     * narrows the inherited-optional wire id without a cast.
     */

    // GIVEN a tool_use block whose wire tool call has no id, plus an attachment
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: { name: "bash", input: {} } },
      {
        type: "attachment",
        attachment: {
          id: "att-1",
          filename: "a.png",
          mimeType: "image/png",
          sizeBytes: 10,
          kind: "image",
        },
      },
      { type: "text", text: "done" },
    ];

    // WHEN the blocks are grouped
    // THEN the id-less tool and the attachment are both absent, leaving the text
    expect(groupContentBlocks(blocks)).toEqual([{ type: "text", text: "done" }]);
  });

  test("empty blocks yield no groups", () => {
    expect(groupContentBlocks([])).toEqual([]);
  });

  test("splitInlineThinking extracts <thinking> tags from text into activity groups", () => {
    /**
     * Models that emit reasoning as inline `<thinking>` text (rather than
     * native thinking blocks) get the same thought-process rendering: the tag
     * body becomes a thinking activity and the remaining text stays a text
     * group, matching macOS's inline tag parsing.
     */

    // GIVEN a text block carrying an inline thinking tag plus a native run
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      { type: "text", text: "<thinking>weigh options</thinking>final answer" },
    ];

    // WHEN grouped with splitInlineThinking
    // THEN the extracted thinking merges into the open activity run and the
    // remaining text closes it
    expect(groupContentBlocks(blocks, { splitInlineThinking: true })).toEqual([
      {
        type: "activity",
        items: [
          { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
          {
            type: "thinking",
            thinking: "weigh options",
            startedAt: undefined,
            completedAt: undefined,
          },
        ],
      },
      { type: "text", text: "final answer" },
    ]);
  });

  test("inline thinking tags pass through verbatim without splitInlineThinking", () => {
    /**
     * User messages must render typed tags verbatim, so the split is opt-in
     * per message role at the call site.
     */
    const blocks: ConversationContentBlock[] = [
      { type: "text", text: "<thinking>typed by a user</thinking>hi" },
    ];
    expect(groupContentBlocks(blocks)).toEqual([
      { type: "text", text: "<thinking>typed by a user</thinking>hi" },
    ]);
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

describe("isRunWorkflowCall", () => {
  test("matches bare run_workflow", () => {
    expect(isRunWorkflowCall(toolCall({ id: "x", name: "run_workflow" }))).toBe(
      true,
    );
  });

  test("matches skill_execute with input.tool === run_workflow", () => {
    expect(
      isRunWorkflowCall(
        toolCall({
          id: "x",
          name: "skill_execute",
          input: { tool: "run_workflow" },
        }),
      ),
    ).toBe(true);
  });

  test("does not match other tools or other skill_execute inputs", () => {
    expect(isRunWorkflowCall(toolCall({ id: "x", name: "bash" }))).toBe(false);
    expect(
      isRunWorkflowCall(
        toolCall({ id: "x", name: "skill_execute", input: { tool: "other" } }),
      ),
    ).toBe(false);
  });
});

describe("isBackgroundBashCall", () => {
  test("matches bash with input.background === true", () => {
    expect(
      isBackgroundBashCall(
        toolCall({ id: "x", name: "bash", input: { background: true } }),
      ),
    ).toBe(true);
  });

  test("matches host_bash with input.background === true", () => {
    expect(
      isBackgroundBashCall(
        toolCall({ id: "x", name: "host_bash", input: { background: true } }),
      ),
    ).toBe(true);
  });

  test("does not match bash without the background flag", () => {
    expect(isBackgroundBashCall(toolCall({ id: "x", name: "bash" }))).toBe(false);
  });

  test("does not match other tools or non-object input", () => {
    expect(
      isBackgroundBashCall(toolCall({ id: "x", name: "subagent_spawn" })),
    ).toBe(false);
    expect(
      isBackgroundBashCall(
        toolCall({ id: "x", name: "bash", input: null as never }),
      ),
    ).toBe(false);
  });
});

describe("extractBgIdFromResult", () => {
  test("returns the bg id for a backgrounded bash result", () => {
    expect(
      extractBgIdFromResult(
        toolCall({
          id: "x",
          name: "bash",
          input: { background: true },
          result: JSON.stringify({ backgrounded: true, id: "bg-123" }),
        }),
      ),
    ).toBe("bg-123");
  });

  test("returns undefined for a foreground (non-backgrounded) result", () => {
    expect(
      extractBgIdFromResult(
        toolCall({
          id: "x",
          name: "bash",
          result: JSON.stringify({ stdout: "ok" }),
        }),
      ),
    ).toBeUndefined();
  });

  test("returns undefined for a non-JSON result", () => {
    expect(
      extractBgIdFromResult(
        toolCall({
          id: "x",
          name: "bash",
          input: { background: true },
          result: "not json",
        }),
      ),
    ).toBeUndefined();
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
