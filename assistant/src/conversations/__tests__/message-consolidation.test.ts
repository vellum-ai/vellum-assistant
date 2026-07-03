import { describe, expect, test } from "bun:test";

import type { MessageRow } from "../../persistence/conversation-crud.js";
import {
  findDisplayTurnEndIndex,
  isToolResultOnlyUserMessage,
  mergeConsecutiveAssistantMessages,
  mergeToolResultsIntoAssistantMessages,
} from "../message-consolidation.js";

function makeMsg(
  role: string,
  content: string,
  overrides: Partial<MessageRow> = {},
): MessageRow {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    conversationId: "conv-1",
    role,
    content,
    createdAt: Date.now(),
    displayOrder: 0,
    seen: 1,
    metadata: null,
    ...overrides,
  } as MessageRow;
}

describe("isToolResultOnlyUserMessage", () => {
  test("returns false for assistant rows", () => {
    expect(isToolResultOnlyUserMessage(makeMsg("assistant", "hello"))).toBe(
      false,
    );
  });

  test("returns false for plain user text (non-JSON content)", () => {
    expect(isToolResultOnlyUserMessage(makeMsg("user", "hello world"))).toBe(
      false,
    );
  });

  test("returns false when JSON content is not an array", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg("user", JSON.stringify({ type: "tool_result" })),
      ),
    ).toBe(false);
  });

  test("returns true for a single tool_result block", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg(
          "user",
          JSON.stringify([
            { type: "tool_result", tool_use_id: "abc", content: "ok" },
          ]),
        ),
      ),
    ).toBe(true);
  });

  test("returns true for a web_search_tool_result block", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg(
          "user",
          JSON.stringify([
            { type: "web_search_tool_result", tool_use_id: "abc" },
          ]),
        ),
      ),
    ).toBe(true);
  });

  test("returns true when tool_result is wrapped with system_notice blocks", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg(
          "user",
          JSON.stringify([
            { type: "tool_result", tool_use_id: "abc" },
            {
              type: "text",
              text: "<system_notice>info</system_notice>",
            },
          ]),
        ),
      ),
    ).toBe(true);
  });

  test("returns false when mixed with real user text", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg(
          "user",
          JSON.stringify([
            { type: "tool_result", tool_use_id: "abc" },
            { type: "text", text: "thanks!" },
          ]),
        ),
      ),
    ).toBe(false);
  });

  test("returns false when there are no tool_result blocks (system_notice alone)", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg(
          "user",
          JSON.stringify([
            {
              type: "text",
              text: "<system_notice>info</system_notice>",
            },
          ]),
        ),
      ),
    ).toBe(false);
  });

  test("returns false for malformed JSON content", () => {
    expect(isToolResultOnlyUserMessage(makeMsg("user", "{not json"))).toBe(
      false,
    );
  });

  test("returns false when array contains a non-object block", () => {
    expect(
      isToolResultOnlyUserMessage(
        makeMsg("user", JSON.stringify(["bare string"])),
      ),
    ).toBe(false);
  });
});

describe("findDisplayTurnEndIndex", () => {
  test("returns startIdx unchanged for negative index", () => {
    const messages = [makeMsg("user", "hi")];
    expect(findDisplayTurnEndIndex(messages, -1)).toBe(-1);
  });

  test("returns startIdx unchanged for out-of-range index", () => {
    const messages = [makeMsg("user", "hi")];
    expect(findDisplayTurnEndIndex(messages, 5)).toBe(5);
  });

  test("returns startIdx unchanged for non-assistant rows", () => {
    const messages = [makeMsg("user", "hi"), makeMsg("assistant", "back")];
    expect(findDisplayTurnEndIndex(messages, 0)).toBe(0);
  });

  test("returns startIdx for a lone assistant row at end of array", () => {
    const messages = [makeMsg("user", "hi"), makeMsg("assistant", "back")];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(1);
  });

  test("advances past consecutive assistant rows", () => {
    const messages = [
      makeMsg("user", "hi"),
      makeMsg("assistant", "step 1"),
      makeMsg("assistant", "step 2"),
      makeMsg("assistant", "step 3"),
      makeMsg("user", "next"),
    ];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(3);
  });

  test("advances across tool-result-only user rows between assistants", () => {
    const messages = [
      makeMsg("user", "lookup data"),
      makeMsg("assistant", "calling tool"),
      makeMsg(
        "user",
        JSON.stringify([
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ]),
      ),
      makeMsg("assistant", "here are the results"),
      makeMsg("user", "thanks"),
    ];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(3);
  });

  test("stops at a real-text user row even after tool-result-only rows", () => {
    const messages = [
      makeMsg("user", "first"),
      makeMsg("assistant", "tool call"),
      makeMsg(
        "user",
        JSON.stringify([{ type: "tool_result", tool_use_id: "t1" }]),
      ),
      makeMsg("assistant", "intermediate"),
      makeMsg("user", "real user follow-up"),
      makeMsg("assistant", "should not be included"),
    ];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(3);
  });

  test("handles assistant followed by tool-result-only user at end of array", () => {
    // No tail assistant follows — the suppressed user row still belongs to
    // the cluster (its tool_result content gets folded into the preceding
    // assistant by the read-path collapse).
    const messages = [
      makeMsg("user", "hi"),
      makeMsg("assistant", "tool call"),
      makeMsg(
        "user",
        JSON.stringify([{ type: "tool_result", tool_use_id: "t1" }]),
      ),
    ];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(2);
  });

  test("handles a long mixed cluster", () => {
    const messages = [
      makeMsg("user", "go"),
      makeMsg("assistant", "A"),
      makeMsg("assistant", "B"),
      makeMsg(
        "user",
        JSON.stringify([{ type: "tool_result", tool_use_id: "t1" }]),
      ),
      makeMsg("assistant", "C"),
      makeMsg(
        "user",
        JSON.stringify([
          { type: "tool_result", tool_use_id: "t2" },
          { type: "text", text: "<system_notice>x</system_notice>" },
        ]),
      ),
      makeMsg("assistant", "D"),
      makeMsg("user", "done"),
    ];
    expect(findDisplayTurnEndIndex(messages, 1)).toBe(6);
  });
});

describe("mergeToolResultsIntoAssistantMessages", () => {
  test("suppresses tool-result-only user rows and lifts blocks onto preceding assistant", () => {
    const messages = [
      makeMsg(
        "assistant",
        JSON.stringify([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
      ),
      makeMsg(
        "user",
        JSON.stringify([
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ]),
      ),
    ];
    const merged = mergeToolResultsIntoAssistantMessages(messages);
    expect(merged).toHaveLength(1);
    expect(merged[0].role).toBe("assistant");
    const blocks = JSON.parse(merged[0].content) as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["tool_use", "tool_result"]);
  });

  test("keeps mixed user messages with their non-tool-result content", () => {
    const messages = [
      makeMsg(
        "assistant",
        JSON.stringify([{ type: "tool_use", id: "t1", name: "x", input: {} }]),
      ),
      makeMsg(
        "user",
        JSON.stringify([
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "thanks!" },
        ]),
      ),
    ];
    const merged = mergeToolResultsIntoAssistantMessages(messages);
    expect(merged).toHaveLength(2);
    expect(merged[1].role).toBe("user");
    const userBlocks = JSON.parse(merged[1].content) as Array<{ type: string }>;
    expect(userBlocks.map((b) => b.type)).toEqual(["text"]);
  });

  test("passes plain user text through unchanged", () => {
    const messages = [makeMsg("user", "hi"), makeMsg("assistant", "hello")];
    const merged = mergeToolResultsIntoAssistantMessages(messages);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toBe("hi");
  });
});

describe("mergeConsecutiveAssistantMessages", () => {
  test("collapses adjacent assistant rows onto the first row", () => {
    const a = makeMsg(
      "assistant",
      JSON.stringify([{ type: "text", text: "part 1" }]),
      { id: "anchor" },
    );
    const b = makeMsg(
      "assistant",
      JSON.stringify([{ type: "text", text: "part 2" }]),
      { id: "tail" },
    );
    const { messages, mergedIdMap } = mergeConsecutiveAssistantMessages([
      makeMsg("user", "hi"),
      a,
      b,
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe("anchor");
    const blocks = JSON.parse(messages[1].content) as Array<{ text: string }>;
    expect(blocks.map((blk) => blk.text)).toEqual(["part 1", "part 2"]);
    expect(mergedIdMap.get("anchor")).toEqual(["tail"]);
  });

  test("leaves a single assistant row unchanged", () => {
    const messages = [
      makeMsg("user", "hi"),
      makeMsg("assistant", JSON.stringify([{ type: "text", text: "hello" }])),
    ];
    const { messages: result, mergedIdMap } =
      mergeConsecutiveAssistantMessages(messages);
    expect(result).toHaveLength(2);
    expect(mergedIdMap.size).toBe(0);
  });

  test("does not merge assistant rows separated by a real user row", () => {
    const messages = [
      makeMsg("assistant", JSON.stringify([{ type: "text", text: "A" }])),
      makeMsg("user", "interrupt"),
      makeMsg("assistant", JSON.stringify([{ type: "text", text: "B" }])),
    ];
    const { messages: result } = mergeConsecutiveAssistantMessages(messages);
    expect(result).toHaveLength(3);
  });
});
