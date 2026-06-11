import { describe, expect, test } from "bun:test";

import { isToolAllowedInChannel } from "../../channels/permission-profiles.js";
import { NO_RESPONSE_TOOL_NAME, noResponseTool } from "../no-response.js";
import type { ToolContext } from "../types.js";

const context = {
  conversationId: "conv-123",
  workingDir: "/tmp",
  trustClass: "guardian",
} as ToolContext;

describe("noResponseTool", () => {
  test("yields the turn back to the user so no follow-up LLM call happens", async () => {
    const result = await noResponseTool.execute({}, context);

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);
  });

  test("accepts an optional reason without changing the outcome", async () => {
    const result = await noResponseTool.execute(
      { reason: "thread chatter not directed at the assistant" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);
  });

  test("bypasses channel permission profiles — silence must never be blocked", () => {
    // No profile configured for this channel id, and the name-based exemption
    // short-circuits before any profile lookup regardless.
    expect(
      isToolAllowedInChannel(
        "channel-restricted",
        NO_RESPONSE_TOOL_NAME,
        noResponseTool.category,
      ),
    ).toBe(true);
  });
});
