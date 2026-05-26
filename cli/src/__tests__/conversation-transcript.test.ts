import { describe, expect, test } from "bun:test";

import {
  formatConversationTranscript,
  lastAssistantResponseText,
  messageText,
} from "../lib/conversation-transcript.js";

describe("conversation transcript helpers", () => {
  test("extracts text from common runtime message shapes", () => {
    expect(messageText({ role: "assistant", text: "hello" })).toBe("hello");
    expect(
      messageText({
        role: "assistant",
        content: [{ type: "text", text: "block text" }],
      }),
    ).toBe("block text");
    expect(
      messageText({
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "json block" }]),
      }),
    ).toBe("json block");
  });

  test("finds the last assistant response", () => {
    expect(
      lastAssistantResponseText([
        { role: "assistant", text: "first" },
        { role: "user", text: "question" },
        { role: "assistant", text: "second" },
      ]),
    ).toBe("second");
  });

  test("returns null when no assistant response has text", () => {
    expect(lastAssistantResponseText([{ role: "user", text: "hello" }])).toBe(
      null,
    );
  });

  test("formats a Markdown transcript", () => {
    const transcript = formatConversationTranscript({
      conversationId: "conv-123",
      title: "Project Alpha",
      exportedAt: new Date("2026-01-02T03:04:05.000Z"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          createdAt: Date.parse("2026-01-02T03:04:00.000Z"),
        },
        {
          role: "assistant",
          text: "Hi there",
          createdAt: Date.parse("2026-01-02T03:04:01.000Z"),
        },
        {
          role: "tool",
          content: [{ type: "text", text: "Tool summary" }],
        },
      ],
    });

    expect(transcript).toContain("# Project Alpha");
    expect(transcript).toContain("Conversation ID: conv-123");
    expect(transcript).toContain("Exported: 2026-01-02T03:04:05.000Z");
    expect(transcript).toContain(
      "### User - 2026-01-02T03:04:00.000Z\n\nHello",
    );
    expect(transcript).toContain(
      "### Assistant - 2026-01-02T03:04:01.000Z\n\nHi there",
    );
    expect(transcript).toContain("### Tool\n\nTool summary");
  });

  test("formats empty conversations", () => {
    expect(
      formatConversationTranscript({
        conversationId: "conv-empty",
        exportedAt: new Date("2026-01-02T03:04:05.000Z"),
        messages: [],
      }),
    ).toContain("_No messages yet._");
  });
});
