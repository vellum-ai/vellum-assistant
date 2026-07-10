import { describe, expect, test } from "bun:test";

import { resolveSummarizeBoundary } from "../daemon/summarize-boundary.js";
import type { MessageRow } from "../persistence/conversation-crud.js";
import { UserError } from "../util/errors.js";

function row(id: string, role: string, content: string): MessageRow {
  return {
    id,
    conversationId: "conv-xyz",
    role,
    content,
    createdAt: 0,
    metadata: null,
    clientMessageId: null,
    finalized: 1,
  };
}

function userText(id: string, text: string): MessageRow {
  return row(id, "user", JSON.stringify([{ type: "text", text }]));
}

function assistantText(id: string, text: string): MessageRow {
  return row(id, "assistant", JSON.stringify([{ type: "text", text }]));
}

function userToolResult(id: string): MessageRow {
  return row(
    id,
    "user",
    JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
    ]),
  );
}

// A tool_result row carrying an injected system_notice, the shape the agent
// loop emits after a post-tool hook.
function userToolResultWithSystemNotice(id: string): MessageRow {
  return row(
    id,
    "user",
    JSON.stringify([
      { type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
      { type: "text", text: "<system_notice>progress check</system_notice>" },
    ]),
  );
}

// Two full turns: [user, assistant, user, assistant].
const twoTurns: MessageRow[] = [
  userText("msg-1", "Hi, I am Alice"),
  assistantText("msg-2", "Hello Alice"),
  userText("msg-3", "Tell me about Bob"),
  assistantText("msg-4", "Bob is a placeholder"),
];

describe("resolveSummarizeBoundary", () => {
  test("plain user-message anchor resolves to itself", () => {
    expect(resolveSummarizeBoundary(twoTurns, "msg-3", 0)).toEqual({
      boundaryRowIndex: 2,
    });
  });

  test("assistant-message anchor snaps back to its turn's user message", () => {
    expect(resolveSummarizeBoundary(twoTurns, "msg-4", 0)).toEqual({
      boundaryRowIndex: 2,
    });
  });

  test("tool-result-only user rows are skipped as anchors", () => {
    const rows: MessageRow[] = [
      userText("msg-1", "First question from Alice"),
      assistantText("msg-2", "Working on it"),
      userText("msg-3", "Second question"),
      assistantText("msg-4", "Running a tool"),
      userToolResult("msg-5"),
      assistantText("msg-6", "Tool finished"),
    ];
    // Anchoring on the tool-result row (or anything after it) snaps past it
    // to the real user message that started the turn.
    expect(resolveSummarizeBoundary(rows, "msg-5", 0)).toEqual({
      boundaryRowIndex: 2,
    });
    expect(resolveSummarizeBoundary(rows, "msg-6", 0)).toEqual({
      boundaryRowIndex: 2,
    });
  });

  test("tool_result + system_notice user rows are continuations, not turn starts", () => {
    const rows: MessageRow[] = [
      userText("msg-1", "First question from Alice"),
      assistantText("msg-2", "Working on it"),
      userText("msg-3", "Second question"),
      assistantText("msg-4", "Running a tool"),
      userToolResultWithSystemNotice("msg-5"),
      assistantText("msg-6", "Tool finished"),
    ];
    // The tool_result row also carries a system_notice text block, so it is not
    // "entirely tool_result" — but it is still a mid-turn continuation. The
    // backward snap must pass it and land on the real user message that started
    // the turn, never leaving the kept tail beginning on an orphaned
    // tool_result whose tool_use was summarized away.
    expect(resolveSummarizeBoundary(rows, "msg-5", 0)).toEqual({
      boundaryRowIndex: 2,
    });
    expect(resolveSummarizeBoundary(rows, "msg-6", 0)).toEqual({
      boundaryRowIndex: 2,
    });
  });

  test("unknown message id throws", () => {
    expect(() => resolveSummarizeBoundary(twoTurns, "msg-999", 0)).toThrow(
      new UserError("Message msg-999 does not belong to this conversation"),
    );
  });

  test("anchor inside the already-compacted prefix throws", () => {
    expect(() => resolveSummarizeBoundary(twoTurns, "msg-3", 2)).toThrow(
      new UserError("Already summarized up to this point"),
    );
  });

  test("anchor whose snapped boundary equals the compacted count throws", () => {
    const rows: MessageRow[] = [
      ...twoTurns,
      userText("msg-5", "Third question"),
      assistantText("msg-6", "Third answer"),
    ];
    // Snaps to index 4; rows [0, 4) are already compacted, so nothing new.
    expect(() => resolveSummarizeBoundary(rows, "msg-6", 4)).toThrow(
      new UserError("Already summarized up to this point"),
    );
  });

  test("first-turn anchor throws (nothing before it to summarize)", () => {
    expect(() => resolveSummarizeBoundary(twoTurns, "msg-1", 0)).toThrow(
      new UserError("Nothing to summarize before this message"),
    );
    expect(() => resolveSummarizeBoundary(twoTurns, "msg-2", 0)).toThrow(
      new UserError("Nothing to summarize before this message"),
    );
  });

  test("no turn start at or before the anchor throws", () => {
    const rows: MessageRow[] = [
      userToolResult("msg-1"),
      assistantText("msg-2", "Resuming from a tool result"),
      userText("msg-3", "A real question"),
    ];
    expect(() => resolveSummarizeBoundary(rows, "msg-2", 0)).toThrow(
      new UserError("Nothing to summarize before this message"),
    );
  });

  test("unparseable content rows are treated as text turn starts", () => {
    const rows: MessageRow[] = [
      userText("msg-1", "Hello"),
      assistantText("msg-2", "Hi"),
      row("msg-3", "user", "plain text, not JSON"),
      assistantText("msg-4", "Understood"),
    ];
    expect(resolveSummarizeBoundary(rows, "msg-4", 0)).toEqual({
      boundaryRowIndex: 2,
    });
  });
});
