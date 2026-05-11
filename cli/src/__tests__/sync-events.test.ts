import { describe, expect, spyOn, test } from "bun:test";

import { renderMarkdown } from "../commands/events.js";

type AssistantEvent = Parameters<typeof renderMarkdown>[0];

function makeEvent(message: AssistantEvent["message"]): AssistantEvent {
  return {
    id: "event-123",
    assistantId: "assistant-123",
    emittedAt: "2026-01-01T00:00:00.000Z",
    message,
  };
}

describe("sync_changed events", () => {
  test("renders sync tags clearly in vellum events markdown output", () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    try {
      renderMarkdown(
        makeEvent({
          type: "sync_changed",
          tags: ["assistant:self:avatar", "conversations:list"],
        }),
      );

      expect(consoleLog).toHaveBeenCalledWith(
        "\n> **Sync changed:** `assistant:self:avatar`, `conversations:list`",
      );
    } finally {
      consoleLog.mockRestore();
    }
  });

  test("tolerates malformed sync tags without throwing", () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() =>
        renderMarkdown(
          makeEvent({
            type: "sync_changed",
            tags: ["assistant:self:avatar", 42, null],
          }),
        ),
      ).not.toThrow();

      expect(consoleLog).toHaveBeenCalledWith(
        "\n> **Sync changed:** `assistant:self:avatar`",
      );
    } finally {
      consoleLog.mockRestore();
    }
  });
});
