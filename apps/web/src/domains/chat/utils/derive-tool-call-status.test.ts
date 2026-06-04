import { describe, expect, test } from "bun:test";

import { deriveToolCallStatus } from "@/domains/chat/utils/derive-tool-call-status";
import type { ConversationMessageToolCall } from "@vellumai/assistant-api";

function make(
  overrides: Partial<ConversationMessageToolCall> = {},
): ConversationMessageToolCall {
  return {
    name: "bash",
    input: {},
    ...overrides,
  } as ConversationMessageToolCall;
}

describe("deriveToolCallStatus", () => {
  test("returns 'running' when neither result, completedAt, nor isError are set", () => {
    expect(deriveToolCallStatus(make())).toBe("running");
  });

  test("returns 'completed' when a result payload is present", () => {
    expect(deriveToolCallStatus(make({ result: "ok" }))).toBe("completed");
  });

  test("returns 'completed' for a force-completed call: completedAt set, no result", () => {
    expect(deriveToolCallStatus(make({ completedAt: 123 }))).toBe("completed");
  });

  test("returns 'error' when isError is true, even with a result payload", () => {
    expect(deriveToolCallStatus(make({ isError: true, result: "boom" }))).toBe(
      "error",
    );
  });

  test("returns 'error' when isError is true and completedAt is set", () => {
    expect(deriveToolCallStatus(make({ isError: true, completedAt: 1 }))).toBe(
      "error",
    );
  });

  test("treats an empty-string result as completed (result is defined)", () => {
    expect(deriveToolCallStatus(make({ result: "" }))).toBe("completed");
  });
});
