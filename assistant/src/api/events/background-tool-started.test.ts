import { describe, expect, test } from "bun:test";

import { BackgroundToolStartedEventSchema } from "./background-tool-started.js";

describe("BackgroundToolStartedEventSchema", () => {
  test("parses a started event", () => {
    const event = {
      type: "background_tool_started" as const,
      id: "bg-1a2b3c4d",
      toolName: "bash",
      conversationId: "conv-abc",
      command: "sleep 30 && echo done",
      startedAt: 1_700_000_000_000,
    };

    const result = BackgroundToolStartedEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("strips an unrecognized field for forward compatibility", () => {
    const result = BackgroundToolStartedEventSchema.safeParse({
      type: "background_tool_started",
      id: "bg-1a2b3c4d",
      toolName: "bash",
      conversationId: "conv-abc",
      command: "echo hi",
      startedAt: 1_700_000_000_000,
      unexpected: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && "unexpected" in result.data).toBe(false);
  });
});
