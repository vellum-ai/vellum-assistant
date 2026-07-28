/**
 * The agent loop bounds every tool result as built-in daemon logic (not a
 * plugin): at the `post-tool-use` chokepoint it tail-drops an oversized result
 * to a budget derived from the model's context window, unconditionally and
 * ahead of every `post-tool-use` hook, so neither a hook nor the provider ever
 * sees an unbounded result. These tests exercise that loop-integrated pass; the
 * truncation transform itself is covered by `tool-result-truncation.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import {
  truncateToolResult,
  TRUNCATION_SUFFIX,
} from "../context/tool-result-truncation.js";
import type { PostToolUseContext } from "../plugin-api/types.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
};

const MAX_INPUT_TOKENS = 10_000;

const readTool: ToolDefinition = {
  name: "read",
  description: "",
  input_schema: { type: "object", properties: {} },
};

/**
 * Drive one tool-calling turn whose executor returns `toolOutput`, and hand
 * back the tool result as it landed in the provider-bound history alongside
 * the emitted `tool_result` events.
 */
async function runToolTurn(toolOutput: string): Promise<{
  historyContent: string;
  events: AgentEvent[];
}> {
  const { provider } = createMockProvider([
    toolUseResponse("t1", "read", {}),
    textResponse("done"),
  ]);
  const loop = new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: "test-conversation",
    config: { maxInputTokens: MAX_INPUT_TOKENS },
    tools: [readTool],
    toolExecutor: async () => ({ content: toolOutput, isError: false }),
  });

  const events: AgentEvent[] = [];
  const { history } = await loop.run({
    requestId: "test-request",
    messages: [userMessage],
    onEvent: (event) => {
      events.push(event);
    },
    trust: { sourceChannel: "vellum", trustClass: "unknown" },
  });

  for (const message of history) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === "t1") {
        return { historyContent: block.content, events };
      }
    }
  }
  throw new Error("no tool result in history");
}

describe("agent loop — built-in tool-result truncation", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("tail-drops an oversized tool result before it joins the history", async () => {
    // GIVEN a tool whose output far exceeds the budget derived from the
    // loop's context window.
    const content = "a".repeat(1_000_000);
    const expected = truncateToolResult(content, MAX_INPUT_TOKENS);
    expect(expected.truncated).toBe(true);

    // WHEN the loop runs the turn.
    const { historyContent } = await runToolTurn(content);

    // THEN the result that joined the provider-bound history is truncated.
    expect(historyContent).toBe(expected.content);
    expect(historyContent).toContain(TRUNCATION_SUFFIX);
  });

  test("emits the truncated content on the tool_result event", async () => {
    // GIVEN an oversized tool output.
    const content = "a".repeat(1_000_000);
    const expected = truncateToolResult(content, MAX_INPUT_TOKENS);

    // WHEN the loop runs the turn.
    const { events } = await runToolTurn(content);

    // THEN the tool_result event carries the truncated copy, so persistence
    // and the clients store what the provider saw.
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.toolUseId === "t1",
    );
    expect(toolResult?.content).toBe(expected.content);
  });

  test("leaves a result that already fits untouched", async () => {
    // GIVEN a tool output well within the budget.
    const content = "small result";

    // WHEN the loop runs the turn.
    const { historyContent } = await runToolTurn(content);

    // THEN it is passed through unchanged.
    expect(historyContent).toBe(content);
  });

  test("truncates ahead of the post-tool-use hook chain", async () => {
    // GIVEN a plugin whose post-tool-use hook records the content it observes.
    let observed: string | null = null;
    registerPlugin({
      manifest: { name: "observer-plugin", version: "0.0.1" },
      hooks: {
        "post-tool-use": async (ctx: PostToolUseContext) => {
          observed = ctx.toolResponse.content;
        },
      },
    });
    const content = "a".repeat(1_000_000);
    const expected = truncateToolResult(content, MAX_INPUT_TOKENS);

    // WHEN the loop runs a turn whose tool returns oversized output.
    await runToolTurn(content);

    // THEN the hook saw the already-truncated result — truncation is not a
    // hook competing for chain position, it runs before the chain.
    expect(observed as string | null).toBe(expected.content);
  });
});
