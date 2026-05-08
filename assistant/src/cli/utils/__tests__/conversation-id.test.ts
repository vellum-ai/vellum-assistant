import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveConversationId } from "../conversation-id.js";

const FAILURE_HELP = "No conversation ID. Provide one explicitly.";

let savedConvId: string | undefined;
let savedSkillCtx: string | undefined;

beforeEach(() => {
  savedConvId = process.env.__CONVERSATION_ID;
  savedSkillCtx = process.env.__SKILL_CONTEXT_JSON;
  delete process.env.__CONVERSATION_ID;
  delete process.env.__SKILL_CONTEXT_JSON;
});

afterEach(() => {
  if (savedConvId !== undefined) {
    process.env.__CONVERSATION_ID = savedConvId;
  } else {
    delete process.env.__CONVERSATION_ID;
  }
  if (savedSkillCtx !== undefined) {
    process.env.__SKILL_CONTEXT_JSON = savedSkillCtx;
  } else {
    delete process.env.__SKILL_CONTEXT_JSON;
  }
});

describe("resolveConversationId", () => {
  test("explicit provided → returns it", () => {
    const result = resolveConversationId({
      explicit: "conv-explicit-123",
      failureHelp: FAILURE_HELP,
    });
    expect(result).toBe("conv-explicit-123");
  });

  test("explicit absent, __SKILL_CONTEXT_JSON has conversationId → returns it", () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({
      conversationId: "conv-from-skill-ctx",
    });
    const result = resolveConversationId({ failureHelp: FAILURE_HELP });
    expect(result).toBe("conv-from-skill-ctx");
  });

  test("both envs absent → throws with provided failureHelp", () => {
    expect(() =>
      resolveConversationId({ failureHelp: FAILURE_HELP }),
    ).toThrow(FAILURE_HELP);
  });

  test("malformed __SKILL_CONTEXT_JSON → falls through to __CONVERSATION_ID", () => {
    process.env.__SKILL_CONTEXT_JSON = "not-valid-json{{{";
    process.env.__CONVERSATION_ID = "conv-from-env";
    const result = resolveConversationId({ failureHelp: FAILURE_HELP });
    expect(result).toBe("conv-from-env");
  });

  test("__SKILL_CONTEXT_JSON without conversationId field → falls through to __CONVERSATION_ID", () => {
    process.env.__SKILL_CONTEXT_JSON = JSON.stringify({ other: "value" });
    process.env.__CONVERSATION_ID = "conv-from-env-fallback";
    const result = resolveConversationId({ failureHelp: FAILURE_HELP });
    expect(result).toBe("conv-from-env-fallback");
  });
});
