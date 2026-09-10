import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import {
  activityHasDedicatedCard,
  activityItemsToCardData,
  type ContentBlockGroup,
  finalResponseStartIndex,
  groupContentBlocks,
  groupOptionsForMessage,
  hasRenderedStepStack,
  hasRenderedThinking,
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
          {
            type: "thinking",
            thinking: "plan",
            startedAt: undefined,
            completedAt: undefined,
          },
          { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
        ],
      },
      { type: "text", text: "answer" },
      {
        type: "activity",
        items: [{ type: "tool_use", toolCall: toolCall({ id: "call-b" }) }],
      },
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
      {
        type: "thinking",
        thinking: "second",
        startedAt: 100,
        completedAt: 900,
      },
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
    expect(groupContentBlocks(blocks)).toEqual([
      { type: "text", text: "done" },
    ]);
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

  test("drops a document_preview surface and merges the run across it", () => {
    /**
     * The transcript draws a response's documents once each, at the end of the
     * response, so the inline preview the daemon emits where the tool ran is
     * not a group at all. Dropping it must not close the open activity run
     * either: the create and the edit either side of it are one run, the way
     * they would have been had the preview never been emitted.
     */
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-create" }) },
      {
        type: "surface",
        surface: {
          surfaceId: "preview-doc-1",
          surfaceType: "document_preview",
          data: { surfaceId: "doc-1", title: "Notes" },
        } as Surface,
      },
      { type: "tool_use", toolCall: toolCall({ id: "call-update" }) },
    ];

    expect(groupContentBlocks(blocks)).toEqual([
      {
        type: "activity",
        items: [
          { type: "tool_use", toolCall: toolCall({ id: "call-create" }) },
          { type: "tool_use", toolCall: toolCall({ id: "call-update" }) },
        ],
      },
    ]);
  });

  test("keeps a non-document surface as its own group", () => {
    // Only `document_preview` is drawn elsewhere; every other surface is
    // content that belongs where it landed.
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      { type: "surface", surface: surface({}) },
    ];

    expect(groupContentBlocks(blocks).map((g) => g.type)).toEqual([
      "activity",
      "surface",
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
    expect(
      isSubagentSpawnCall(toolCall({ id: "x", name: "subagent_spawn" })),
    ).toBe(true);
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
    expect(isSubagentSpawnCall(toolCall({ id: "x", name: "bash" }))).toBe(
      false,
    );
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
    expect(isBackgroundBashCall(toolCall({ id: "x", name: "bash" }))).toBe(
      false,
    );
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
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_show" }))).toBe(
      true,
    );
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_update" }))).toBe(
      true,
    );
    expect(isSuppressedUiTool(toolCall({ id: "x", name: "ui_dismiss" }))).toBe(
      true,
    );
  });

  test("suppresses send_user_message, which renders as the prose it carries", () => {
    expect(
      isSuppressedUiTool(toolCall({ id: "x", name: "send_user_message" })),
    ).toBe(true);
    // Suppressed even carrying a confirmation: the tool has no confirmation
    // policy, so a chip for it would only ever duplicate the reply.
    expect(
      isSuppressedUiTool(
        toolCall({
          id: "x",
          name: "send_user_message",
          pendingConfirmation: { requestId: "req-1" },
        }),
      ),
    ).toBe(true);
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
        surface({
          template: "task_progress",
          templateData: { steps: [{ id: "1" }] },
        }),
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
      isTaskProgressSurface(
        surface({ template: "task_progress", templateData: {} }),
      ),
    ).toBe(false);
    expect(
      isTaskProgressSurface(surface({ template: "weather_forecast" })),
    ).toBe(false);
  });
});

describe("finalResponseStartIndex", () => {
  const textGroup = (value: string): ContentBlockGroup => ({
    type: "text",
    text: value,
  });
  const surfaceGroup = (): ContentBlockGroup => ({
    type: "surface",
    surface: { surfaceId: "s1", surfaceType: "choice", data: {} },
  });
  const activityGroup = (): ContentBlockGroup => ({
    type: "activity",
    items: [{ type: "tool_use", toolCall: toolCall({ id: "tc-1" }) }],
  });

  /** Every group draws visible output except the indexes named by `blank`. */
  function drawsVisibleOutput(blank: number[] = []) {
    return (_group: ContentBlockGroup, index: number) => !blank.includes(index);
  }

  test("prose opening an interactive surface is the response, not earlier work", () => {
    // The onboarding greeting's shape: prose, the `ui_show` call that draws
    // nothing, the choice surface, then a scrap of trailing text.
    const groups: ContentBlockGroup[] = [
      textGroup("Hey there, shall we start with your work?"),
      activityGroup(),
      surfaceGroup(),
      textGroup("Sparkle"),
    ];
    expect(finalResponseStartIndex(groups, drawsVisibleOutput([1]))).toBe(0);
  });

  test("keeps intermediate text before a drawn tool run out of the response", () => {
    const groups: ContentBlockGroup[] = [
      textGroup("I will check that."),
      activityGroup(),
      textGroup("Here is the final answer."),
    ];
    expect(finalResponseStartIndex(groups, drawsVisibleOutput())).toBe(2);
  });

  test("a group that draws nothing does not pull earlier text into the response", () => {
    const groups: ContentBlockGroup[] = [
      textGroup("I will check that."),
      activityGroup(),
      textGroup("Here is the final answer."),
    ];
    expect(finalResponseStartIndex(groups, drawsVisibleOutput([1]))).toBe(2);
  });

  test("every text block introducing a surface joins the response", () => {
    const groups: ContentBlockGroup[] = [
      textGroup("Hey there."),
      textGroup("Shall we start with your work?"),
      activityGroup(),
      surfaceGroup(),
      textGroup("Sparkle"),
    ];
    expect(finalResponseStartIndex(groups, drawsVisibleOutput([2]))).toBe(0);
  });

  test("a drawn tool run ends the response, surface or not", () => {
    const groups: ContentBlockGroup[] = [
      textGroup("Let me look that up."),
      activityGroup(),
      surfaceGroup(),
      textGroup("Here is the final answer."),
    ];
    expect(finalResponseStartIndex(groups, drawsVisibleOutput())).toBe(2);
  });

  test("visible card-backed activity ends the response so earlier prose stays collapsible", () => {
    // Prose, a process card with no timeline row, a later surface, then a
    // trailing scrap. The card is visible output, so it bounds the reply.
    const groups: ContentBlockGroup[] = [
      textGroup("Let me ask first."),
      {
        type: "activity",
        items: [
          {
            type: "tool_use",
            toolCall: toolCall({ id: "tc-ask", name: "ask_question" }),
          },
        ],
      },
      surfaceGroup(),
      textGroup("Sparkle"),
    ];
    const includingDedicatedCard = (
      group: ContentBlockGroup,
      _index: number,
    ): boolean => {
      if (group.type === "text") {
        return group.text.trim().length > 0;
      }
      if (group.type === "surface") {
        return true;
      }
      return activityHasDedicatedCard(group.items, () => true);
    };
    expect(finalResponseStartIndex(groups, includingDedicatedCard)).toBe(2);
  });

  test("returns -1 for a response carrying no text", () => {
    expect(
      finalResponseStartIndex([activityGroup()], drawsVisibleOutput()),
    ).toBe(-1);
  });
});

describe("activityHasDedicatedCard", () => {
  test("matches a subagent spawn even when nothing is marked card-backed", () => {
    expect(
      activityHasDedicatedCard(
        [
          {
            type: "tool_use",
            toolCall: toolCall({ id: "x", name: "subagent_spawn" }),
          },
        ],
        () => false,
      ),
    ).toBe(true);
  });

  test("matches a skill_execute subagent spawn", () => {
    expect(
      activityHasDedicatedCard(
        [
          {
            type: "tool_use",
            toolCall: toolCall({
              id: "x",
              name: "skill_execute",
              input: { tool: "subagent_spawn" },
            }),
          },
        ],
        () => false,
      ),
    ).toBe(true);
  });

  test("matches a call the render path marks card-backed", () => {
    expect(
      activityHasDedicatedCard(
        [
          {
            type: "tool_use",
            toolCall: toolCall({ id: "x", name: "run_workflow" }),
          },
        ],
        (tc) => tc.name === "run_workflow",
      ),
    ).toBe(true);
  });

  test("does not match a plain tool chip", () => {
    expect(
      activityHasDedicatedCard(
        [{ type: "tool_use", toolCall: toolCall({ id: "x", name: "bash" }) }],
        () => false,
      ),
    ).toBe(false);
  });

  test("does not match thinking-only activity", () => {
    expect(
      activityHasDedicatedCard(
        [{ type: "thinking", thinking: "plan" }],
        () => true,
      ),
    ).toBe(false);
  });
});

describe("send_user_message in the transcript projection", () => {
  test("opens no activity group of its own", () => {
    // GIVEN the live block order of a tool-gated turn: the reply arrives as a
    // text delta, then the call that carried it
    const blocks: ConversationContentBlock[] = [
      { type: "text", text: "Here you go." },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-send", name: "send_user_message" }),
      },
    ];

    // WHEN grouped
    // THEN only the prose survives. A trailing activity run would draw a
    // shimmering "Thinking" row under the reply while streaming.
    expect(groupContentBlocks(blocks)).toEqual([
      { type: "text", text: "Here you go." },
    ]);
  });

  test("does not split the activity run around it", () => {
    // GIVEN work either side of a reply the model sent mid-turn
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-send", name: "send_user_message" }),
      },
      { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
    ];

    // WHEN grouped
    // THEN the two real steps merge into one run, as they would had the reply
    // never been sent
    expect(groupContentBlocks(blocks)).toEqual([
      {
        type: "activity",
        items: [
          { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
          { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
        ],
      },
    ]);
  });

  test("counts no step and draws no chip when it reaches the card data", () => {
    const { cardItems, toolCalls } = activityItemsToCardData([
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-send", name: "send_user_message" }),
      },
    ]);

    expect(toolCalls.map((tc) => tc.id)).toEqual(["call-a"]);
    expect(cardItems).toEqual([
      { kind: "toolCall", toolCall: toolCall({ id: "call-a" }) },
    ]);
  });
});

describe("a private row's reasoning", () => {
  const blocks: ConversationContentBlock[] = [
    { type: "thinking", thinking: "let me look that up" },
    { type: "tool_use", toolCall: toolCall({ id: "call-a", name: "bash" }) },
    { type: "text", text: "Here you go." },
  ];

  test("is dropped from the projection, leaving the work it did", () => {
    const groups = groupContentBlocks(
      blocks,
      groupOptionsForMessage({
        role: "assistant",
        assistantTextVisibility: "private",
      }),
    );
    expect(groups).toEqual([
      {
        type: "activity",
        items: [
          {
            type: "tool_use",
            toolCall: toolCall({ id: "call-a", name: "bash" }),
          },
        ],
      },
      { type: "text", text: "Here you go." },
    ]);
  });

  test("survives on a row carrying no marker", () => {
    const groups = groupContentBlocks(
      blocks,
      groupOptionsForMessage({ role: "assistant" }),
    );
    expect(groups[0]).toEqual({
      type: "activity",
      items: [
        {
          type: "thinking",
          thinking: "let me look that up",
          startedAt: undefined,
          completedAt: undefined,
        },
        {
          type: "tool_use",
          toolCall: toolCall({ id: "call-a", name: "bash" }),
        },
      ],
    });
  });

  test("counts only tool calls the projection renders as steps", () => {
    expect(hasRenderedStepStack({ toolCalls: [] })).toBe(false);
    expect(
      hasRenderedStepStack({
        toolCalls: [{ name: "send_user_message" }, { name: "remember" }],
      }),
    ).toBe(false);
    expect(
      hasRenderedStepStack({
        toolCalls: [{ name: "remember" }, { name: "file_write" }],
      }),
    ).toBe(true);
  });

  test("leaves the thinking dots owning the wait", () => {
    // The inline link defers the dots row only when it actually renders.
    expect(
      hasRenderedThinking({
        role: "assistant",
        assistantTextVisibility: "private",
        contentBlocks: [{ type: "thinking", thinking: "let me look that up" }],
      }),
    ).toBe(false);
    expect(
      hasRenderedThinking({
        role: "assistant",
        contentBlocks: [{ type: "thinking", thinking: "let me look that up" }],
      }),
    ).toBe(true);
    expect(
      hasRenderedThinking({
        role: "assistant",
        assistantTextVisibility: "private",
        thinkingSegments: ["let me look that up"],
      }),
    ).toBe(false);
  });

  test("goes the same way for an unmarked row under the transcript-wide gate", () => {
    expect(
      groupOptionsForMessage({ role: "assistant" }, true).dropThinking,
    ).toBe(true);
    expect(hasRenderedThinking({ role: "assistant" }, true)).toBe(false);
    expect(
      groupContentBlocks(
        blocks,
        groupOptionsForMessage({ role: "assistant" }, true),
      ),
    ).toEqual([
      {
        type: "activity",
        items: [
          {
            type: "tool_use",
            toolCall: toolCall({ id: "call-a", name: "bash" }),
          },
        ],
      },
      { type: "text", text: "Here you go." },
    ]);
  });

  test("a user row never splits its own inline tags", () => {
    expect(groupOptionsForMessage({ role: "user" }).splitInlineThinking).toBe(
      false,
    );
  });
});

describe("silent tools in the transcript projection", () => {
  /** The options a transcript rendered with the flag on projects a row with. */
  const flagOn = groupOptionsForMessage({ role: "assistant" }, true);

  test("a bookkeeping call after the reply opens no activity group", () => {
    // GIVEN a delivered reply followed by the memory write the assistant made
    // once it had answered
    const blocks: ConversationContentBlock[] = [
      { type: "text", text: "Here you go." },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-remember", name: "remember" }),
      },
    ];

    // WHEN grouped with the flag on
    // THEN only the prose survives. A trailing activity run would draw a
    // "Noting dropped essay request" row under a finished answer.
    expect(groupContentBlocks(blocks, flagOn)).toEqual([
      { type: "text", text: "Here you go." },
    ]);
  });

  test("does not split the activity run around one", () => {
    // GIVEN real work either side of a memory write
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-remember", name: "remember" }),
      },
      { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
    ];

    // WHEN grouped with the flag on
    // THEN the two real steps merge into one run, so the step count reads 2
    const groups = groupContentBlocks(blocks, flagOn);
    expect(groups).toEqual([
      {
        type: "activity",
        items: [
          { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
          { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
        ],
      },
    ]);
    const group = groups[0];
    expect(group?.type === "activity" ? group.items : []).toHaveLength(2);
    expect(
      activityItemsToCardData(
        group?.type === "activity" ? group.items : [],
      ).toolCalls.map((tc) => tc.id),
    ).toEqual(["call-a", "call-b"]);
  });

  test("keeps drawing every step with the flag off", () => {
    // The flag-off transcript is untouched: the same blocks still group into
    // one run of three steps.
    const blocks: ConversationContentBlock[] = [
      { type: "tool_use", toolCall: toolCall({ id: "call-a" }) },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-remember", name: "remember" }),
      },
      { type: "tool_use", toolCall: toolCall({ id: "call-b" }) },
    ];

    const group = groupContentBlocks(
      blocks,
      groupOptionsForMessage({ role: "assistant" }),
    )[0];
    expect(group?.type === "activity" ? group.items : []).toHaveLength(3);
  });

  test("keeps a surface tool carrying a pending confirmation", () => {
    // The chip is where the inline confirmation card renders, so dropping the
    // call would leave the user nothing to answer.
    const blocks: ConversationContentBlock[] = [
      {
        type: "tool_use",
        toolCall: toolCall({
          id: "call-ui",
          name: "ui_show",
          pendingConfirmation: { requestId: "req-1" },
        }),
      },
    ];

    expect(groupContentBlocks(blocks, flagOn)).toEqual([
      {
        type: "activity",
        items: [
          {
            type: "tool_use",
            toolCall: toolCall({
              id: "call-ui",
              name: "ui_show",
              pendingConfirmation: { requestId: "req-1" },
            }),
          },
        ],
      },
    ]);
  });

  test("keeps the work the user asked for", () => {
    const blocks: ConversationContentBlock[] = [
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-bash", name: "bash" }),
      },
      {
        type: "tool_use",
        toolCall: toolCall({ id: "call-ask", name: "ask_question" }),
      },
    ];

    const group = groupContentBlocks(blocks, flagOn)[0];
    expect(group?.type === "activity" ? group.items : []).toHaveLength(2);
  });
});
