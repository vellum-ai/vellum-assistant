import { describe, expect, test } from "bun:test";

import { BackgroundToolCompletedEventSchema } from "./background-tool-completed.js";

describe("BackgroundToolCompletedEventSchema", () => {
  test("parses a completed event with exit code and output", () => {
    const event = {
      type: "background_tool_completed" as const,
      id: "bg-1a2b3c4d",
      conversationId: "conv-abc",
      status: "completed" as const,
      exitCode: 0,
      output: "done\n",
      completedAt: 1_700_000_001_000,
    };

    const result = BackgroundToolCompletedEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("parses a completed event without the optional fields", () => {
    const event = {
      type: "background_tool_completed" as const,
      id: "bg-1a2b3c4d",
      conversationId: "conv-abc",
      status: "cancelled" as const,
      completedAt: 1_700_000_001_000,
    };

    const result = BackgroundToolCompletedEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("strips an unrecognized field for forward compatibility", () => {
    const result = BackgroundToolCompletedEventSchema.safeParse({
      type: "background_tool_completed",
      id: "bg-1a2b3c4d",
      conversationId: "conv-abc",
      status: "failed",
      completedAt: 1_700_000_001_000,
      unexpected: true,
    });

    expect(result.success).toBe(true);
    expect(result.success && "unexpected" in result.data).toBe(false);
  });
});
