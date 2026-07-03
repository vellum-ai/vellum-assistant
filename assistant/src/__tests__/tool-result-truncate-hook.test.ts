/**
 * Tests for the default `tool-result-truncate` plugin's `post-tool-use` hook.
 *
 * Covers:
 * - The hook tail-drops an oversized `toolResponse.content` to the budget
 *   derived from `maxInputTokens`, matching `truncateToolResult`, and is a
 *   no-op for content that already fits.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire and truncate the tool response.
 * - Chain ordering: because defaults register first, the default hook runs
 *   ahead of a later-registered user hook, which therefore observes an
 *   already-truncated response.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import postToolUse from "../plugins/defaults/tool-result-truncate/hooks/post-tool-use.js";
import {
  truncateToolResult,
  TRUNCATION_SUFFIX,
} from "../plugins/defaults/tool-result-truncate/terminal.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { ToolResultContent } from "../providers/types.js";

const defaultToolResultTruncatePlugin = getAllDefaultPlugins().find(
  (p) => p.manifest.name === "default-tool-result-truncate",
)!;

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const MAX_INPUT_TOKENS = 10_000;

function makeToolResponse(content: string): ToolResultContent {
  return { type: "tool_result", tool_use_id: "tu_1", content };
}

function makeCtx(content: string): PostToolUseContext {
  return {
    conversationId: "conv-test",
    toolResponse: makeToolResponse(content),
    messages: [],
    additionalContext: null,
    model: "claude-test-model",
    maxInputTokens: MAX_INPUT_TOKENS,
    callSite: "mainAgent",
    supportsDynamicUi: true,
    logger: noopLogger,
  };
}

describe("tool-result-truncate post-tool-use hook — direct", () => {
  test("truncates oversized content identically to truncateToolResult", async () => {
    // GIVEN a tool response whose content far exceeds the derived budget.
    const content = "a".repeat(1_000_000);
    const expected = truncateToolResult(content, MAX_INPUT_TOKENS);
    const ctx = makeCtx(content);

    // WHEN the hook runs over the context.
    await postToolUse(ctx);

    // THEN the response content matches the canonical truncation output.
    expect(expected.truncated).toBe(true);
    expect(ctx.toolResponse.content).toBe(expected.content);
    expect(ctx.toolResponse.content).toContain(TRUNCATION_SUFFIX);
  });

  test("is a no-op for content that already fits the budget", async () => {
    // GIVEN a tool response well within the derived budget.
    const content = "small result";
    const ctx = makeCtx(content);

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN the content is unchanged.
    expect(ctx.toolResponse.content).toBe(content);
  });
});

describe("tool-result-truncate post-tool-use hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin truncates an oversized response", async () => {
    // GIVEN the default tool-result-truncate plugin is registered.
    registerPlugin(defaultToolResultTruncatePlugin);
    const content = "a".repeat(1_000_000);
    const expected = truncateToolResult(content, MAX_INPUT_TOKENS);

    // WHEN the post-tool-use chain runs.
    const result = await runHook<PostToolUseContext>(
      HOOKS.POST_TOOL_USE,
      makeCtx(content),
    );

    // THEN the tool response is truncated.
    expect(result.toolResponse.content).toBe(expected.content);
  });

  test("default hook runs before a later-registered user hook", async () => {
    // GIVEN the default plugin is registered first, then a user plugin whose
    // hook records the response content it observes.
    let observed: string | null = null;
    registerPlugin(defaultToolResultTruncatePlugin);
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

    // WHEN the chain runs.
    await runHook<PostToolUseContext>(HOOKS.POST_TOOL_USE, makeCtx(content));

    // THEN the user hook saw the already-truncated content.
    expect(observed as string | null).toBe(expected.content);
  });
});
