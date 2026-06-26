import { describe, expect, test } from "bun:test";

import { AssistantEventSchema } from "../index.js";
import { AcpSessionUpdateEventSchema } from "./acp-session-update.js";

describe("AcpSessionUpdateEventSchema", () => {
  test("accepts a tool_call event carrying locations and round-trips the field", () => {
    const event = {
      type: "acp_session_update" as const,
      acpSessionId: "acp-1",
      updateType: "tool_call" as const,
      toolCallId: "tool-1",
      toolTitle: "Edit file",
      toolKind: "edit",
      toolStatus: "in_progress",
      locations: [{ path: "src/foo.ts", line: 42 }, { path: "src/bar.ts" }],
    };

    const result = AcpSessionUpdateEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    expect(result.success && result.data.locations).toEqual([
      { path: "src/foo.ts", line: 42 },
      { path: "src/bar.ts" },
    ]);
  });

  test("accepts a locations-bearing event through the AssistantEventSchema union", () => {
    const event = {
      type: "acp_session_update" as const,
      acpSessionId: "acp-1",
      updateType: "tool_call_update" as const,
      toolCallId: "tool-1",
      locations: [{ path: "src/baz.ts", line: 7 }],
    };

    const result = AssistantEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    expect(
      result.success &&
        result.data.type === "acp_session_update" &&
        result.data.locations,
    ).toEqual([{ path: "src/baz.ts", line: 7 }]);
  });

  test("still accepts a normal event without locations", () => {
    const event = {
      type: "acp_session_update" as const,
      acpSessionId: "acp-1",
      updateType: "agent_message_chunk" as const,
      content: "hello",
      messageId: "msg-1",
    };

    const result = AcpSessionUpdateEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    expect(result.success && result.data.locations).toBeUndefined();
  });

  test("still rejects unrecognized keys (schema remains strict)", () => {
    const event = {
      type: "acp_session_update" as const,
      acpSessionId: "acp-1",
      updateType: "tool_call" as const,
      bogusField: "nope",
    };

    const result = AcpSessionUpdateEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});
