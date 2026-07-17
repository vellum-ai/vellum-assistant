import { describe, expect, test } from "bun:test";

import { OpenConversationEventSchema } from "./open-conversation.js";

describe("OpenConversationEventSchema", () => {
  test("parses an event with all fields", () => {
    const event = {
      type: "open_conversation" as const,
      conversationId: "conv-abc",
      title: "New conversation",
      anchorMessageId: "msg-42",
      focus: true,
    };

    const result = OpenConversationEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("parses an event with only the required conversationId", () => {
    const event = {
      type: "open_conversation" as const,
      conversationId: "conv-abc",
    };

    const result = OpenConversationEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("parses a non-focusing fan-out open", () => {
    const event = {
      type: "open_conversation" as const,
      conversationId: "conv-abc",
      focus: false,
    };

    const result = OpenConversationEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data.focus).toBe(false);
  });

  test("rejects an event missing conversationId", () => {
    const result = OpenConversationEventSchema.safeParse({
      type: "open_conversation",
    });

    expect(result.success).toBe(false);
  });

  test("strips an unrecognized field for forward compatibility", () => {
    const result = OpenConversationEventSchema.safeParse({
      type: "open_conversation",
      conversationId: "conv-abc",
      seq: 7,
    });

    expect(result.success).toBe(true);
    expect(result.success && "seq" in result.data).toBe(false);
  });
});
