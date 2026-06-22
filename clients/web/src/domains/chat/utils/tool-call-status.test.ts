import { describe, expect, test } from "bun:test";

import {
  isToolCallCompleted,
  isToolCallRunning,
  toolCallRank,
} from "@/domains/chat/utils/tool-call-status";
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

describe("isToolCallRunning", () => {
  test("is running when neither result, completedAt, nor isError are set", () => {
    expect(isToolCallRunning(make())).toBe(true);
  });

  test("is not running once a result payload is present", () => {
    expect(isToolCallRunning(make({ result: "ok" }))).toBe(false);
  });

  test("is not running for a force-completed call: completedAt set, no result", () => {
    expect(isToolCallRunning(make({ completedAt: 123 }))).toBe(false);
  });

  test("is not running when isError is true", () => {
    expect(isToolCallRunning(make({ isError: true }))).toBe(false);
  });

  test("treats an empty-string result as terminal (result is defined)", () => {
    expect(isToolCallRunning(make({ result: "" }))).toBe(false);
  });
});

describe("isToolCallCompleted", () => {
  test("is completed when a result payload is present", () => {
    expect(isToolCallCompleted(make({ result: "ok" }))).toBe(true);
  });

  test("is completed for a force-completed call: completedAt set, no result", () => {
    expect(isToolCallCompleted(make({ completedAt: 123 }))).toBe(true);
  });

  test("is not completed while still running", () => {
    expect(isToolCallCompleted(make())).toBe(false);
  });

  test("is not completed when isError is true, even with a result payload", () => {
    expect(isToolCallCompleted(make({ isError: true, result: "boom" }))).toBe(
      false,
    );
  });
});

describe("toolCallRank", () => {
  test("ranks error (2) above completed (1) above running (0)", () => {
    const running = toolCallRank(make());
    const completed = toolCallRank(make({ completedAt: 1 }));
    const errored = toolCallRank(make({ isError: true }));
    expect(running).toBe(0);
    expect(completed).toBe(1);
    expect(errored).toBe(2);
    expect(errored).toBeGreaterThan(completed);
    expect(completed).toBeGreaterThan(running);
  });

  test("ranks an errored call as terminal even with a result payload", () => {
    expect(toolCallRank(make({ isError: true, result: "boom" }))).toBe(2);
  });

  test("ranks a result-bearing call as completed", () => {
    expect(toolCallRank(make({ result: "ok" }))).toBe(1);
  });
});
