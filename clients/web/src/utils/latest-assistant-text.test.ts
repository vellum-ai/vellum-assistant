import { describe, expect, test } from "bun:test";

import type { ConversationMessage } from "@vellumai/assistant-api";

import { latestAssistantText } from "./latest-assistant-text";

function makeMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "msg-1",
    role: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

describe("latestAssistantText", () => {
  test("joins the text blocks of the latest assistant message", () => {
    const messages = [
      makeMessage({
        id: "msg-old",
        contentBlocks: [{ type: "text", text: "older reply" }],
      }),
      makeMessage({ id: "msg-user", role: "user" }),
      makeMessage({
        id: "msg-new",
        contentBlocks: [
          { type: "text", text: "first paragraph" },
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "second paragraph" },
        ],
      }),
    ];

    expect(latestAssistantText(messages)).toBe(
      "first paragraph\nsecond paragraph",
    );
  });

  test("returns empty string when there is no assistant message", () => {
    expect(latestAssistantText([])).toBe("");
    expect(latestAssistantText([makeMessage({ role: "user" })])).toBe("");
  });

  test("returns empty string for an assistant message with no text blocks", () => {
    const messages = [
      makeMessage({
        contentBlocks: [{ type: "thinking", thinking: "only reasoning" }],
      }),
    ];

    expect(latestAssistantText(messages)).toBe("");
  });
});
