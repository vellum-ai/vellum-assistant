import { describe, expect, test } from "bun:test";

import {
  SUBAGENT_LIMITS,
  type SubagentConfig,
  type SubagentState,
  type SubagentStatus,
  TERMINAL_STATUSES,
} from "../subagent/types.js";

describe("SubagentStatus terminal states", () => {
  test("completed, failed, and aborted are terminal", () => {
    expect(TERMINAL_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_STATUSES.has("aborted")).toBe(true);
  });

  test("pending, running, and awaiting_input are NOT terminal", () => {
    expect(TERMINAL_STATUSES.has("pending")).toBe(false);
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_STATUSES.has("awaiting_input")).toBe(false);
  });
});

describe("SUBAGENT_LIMITS", () => {
  test("has expected defaults", () => {
    expect(SUBAGENT_LIMITS.maxDepth).toBe(1);
  });
});

describe("SubagentConfig type shape", () => {
  test("can create a valid config object", () => {
    const config: SubagentConfig = {
      id: "test-id",
      parentConversationId: "parent-id",
      label: "Test subagent",
      objective: "Do something",
    };
    expect(config.id).toBe("test-id");
    expect(config.context).toBeUndefined();
    expect(config.systemPromptOverride).toBeUndefined();
  });

  test("supports optional fields", () => {
    const config: SubagentConfig = {
      id: "test-id",
      parentConversationId: "parent-id",
      label: "Test subagent",
      objective: "Do something",
      context: "Extra context",
      systemPromptOverride: "Custom prompt",
      preactivatedSkillIds: ["skill-1"],
    };
    expect(config.context).toBe("Extra context");
    expect(config.systemPromptOverride).toBe("Custom prompt");
    expect(config.preactivatedSkillIds).toEqual(["skill-1"]);
  });
});

describe("SubagentState type shape", () => {
  test("can create a valid state object", () => {
    const state: SubagentState = {
      config: {
        id: "test-id",
        parentConversationId: "parent-id",
        label: "Test",
        objective: "Do something",
      },
      status: "pending" as SubagentStatus,
      conversationId: "conv-id",
      createdAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    };
    expect(state.status).toBe("pending");
    expect(state.error).toBeUndefined();
    expect(state.startedAt).toBeUndefined();
    expect(state.completedAt).toBeUndefined();
  });
});
