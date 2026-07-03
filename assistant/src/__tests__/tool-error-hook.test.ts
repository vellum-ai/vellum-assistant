/**
 * Tests for the default `tool-error` plugin's `post-tool-use` hook.
 *
 * Covers:
 * - The hook surfaces the canonical coaching notice via `additionalContext`
 *   (leaving the tool result's `content` untouched) when the result carries
 *   `is_error`, and is a no-op for a successful result.
 * - The consecutive-failure guard is derived from the conversation history per
 *   tool name: coaching fires on the 1st through Nth back-to-back failure of a
 *   tool and is dropped once that tool exceeds the cap. A success in between
 *   resets the streak, and failures of a different tool don't count.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire, and the default runs ahead of a later
 *   user hook so the user observes the already-set `additionalContext`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import postToolUse, {
  TOOL_ERROR_NUDGE_TEXT,
} from "../plugins/defaults/tool-error/hooks/post-tool-use.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message, ToolResultContent } from "../providers/types.js";

const defaultToolErrorPlugin = getAllDefaultPlugins().find(
  (p) => p.manifest.name === "default-tool-error",
)!;

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const BASE_CONTENT = "tool blew up";

/** Assistant turn issuing a single `tool_use` block. */
function toolUseTurn(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

/** User turn carrying a single `tool_result` for a prior `tool_use`. */
function toolResultTurn(toolUseId: string, isError: boolean): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "result",
        is_error: isError,
      },
    ],
  };
}

function errorResponse(toolUseId: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: BASE_CONTENT,
    is_error: true,
  };
}

function makeCtx(
  toolResponse: ToolResultContent,
  messages: Message[],
): PostToolUseContext {
  return {
    conversationId: "conv-tool-error-test",
    toolResponse,
    messages,
    additionalContext: null,
    model: "claude-test-model",
    maxInputTokens: 10_000,
    callSite: "mainAgent",
    supportsDynamicUi: true,
    logger: noopLogger,
  };
}

/**
 * Build a history of `priorErrors` back-to-back failures of `toolName`,
 * followed by the current turn's `tool_use` (whose result is delivered via
 * `ctx.toolResponse`, not history). Returns the history and the current
 * tool_use id.
 */
function historyWithConsecutiveErrors(
  toolName: string,
  priorErrors: number,
): { messages: Message[]; currentToolUseId: string } {
  const messages: Message[] = [];
  for (let i = 0; i < priorErrors; i++) {
    const id = `${toolName}-${i}`;
    messages.push(toolUseTurn(id, toolName));
    messages.push(toolResultTurn(id, true));
  }
  const currentToolUseId = `${toolName}-current`;
  messages.push(toolUseTurn(currentToolUseId, toolName));
  return { messages, currentToolUseId };
}

describe("tool-error post-tool-use hook — direct", () => {
  test("surfaces the canonical coaching notice via additionalContext on a first error", async () => {
    // GIVEN an error result whose tool has not failed before.
    const { messages, currentToolUseId } = historyWithConsecutiveErrors(
      "search",
      0,
    );
    const ctx = makeCtx(errorResponse(currentToolUseId), messages);

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN the coaching notice is surfaced via additionalContext, and the tool
    // result's own content is left untouched.
    expect(ctx.additionalContext).toBe(TOOL_ERROR_NUDGE_TEXT);
    expect(ctx.toolResponse.content).toBe(BASE_CONTENT);
  });

  test("is a no-op for a successful result", async () => {
    // GIVEN a successful result for a tool.
    const messages = [toolUseTurn("search-current", "search")];
    const ctx = makeCtx(
      {
        type: "tool_result",
        tool_use_id: "search-current",
        content: BASE_CONTENT,
        is_error: false,
      },
      messages,
    );

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN no coaching is surfaced and the content is left untouched.
    expect(ctx.additionalContext).toBeNull();
    expect(ctx.toolResponse.content).toBe(BASE_CONTENT);
  });

  test("keeps coaching up to and including the consecutive-failure cap", async () => {
    // GIVEN a tool that has already failed 0, 1, then 2 times in a row — so the
    // current failure is the 1st, 2nd, then 3rd (the cap) consecutive failure.
    for (let priorErrors = 0; priorErrors <= 2; priorErrors++) {
      const { messages, currentToolUseId } = historyWithConsecutiveErrors(
        "search",
        priorErrors,
      );
      const ctx = makeCtx(errorResponse(currentToolUseId), messages);

      // WHEN the hook runs.
      await postToolUse(ctx);

      // THEN it still coaches the retry.
      expect(ctx.additionalContext).toBe(TOOL_ERROR_NUDGE_TEXT);
    }
  });

  test("drops the coaching once the tool exceeds the cap", async () => {
    // GIVEN a tool that has already failed 3 times in a row, so the current
    // failure is the 4th — past the cap of 3.
    const { messages, currentToolUseId } = historyWithConsecutiveErrors(
      "search",
      3,
    );
    const ctx = makeCtx(errorResponse(currentToolUseId), messages);

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN no coaching is surfaced (the error is likely unrecoverable) and the
    // result is left untouched.
    expect(ctx.additionalContext).toBeNull();
    expect(ctx.toolResponse.content).toBe(BASE_CONTENT);
  });

  test("a successful result between failures resets the streak", async () => {
    // GIVEN four failures of "search" but with a success in the middle, so the
    // trailing run of failures is only two — the current failure is the 3rd.
    const messages: Message[] = [
      toolUseTurn("search-0", "search"),
      toolResultTurn("search-0", true),
      toolUseTurn("search-1", "search"),
      toolResultTurn("search-1", true),
      toolUseTurn("search-2", "search"),
      toolResultTurn("search-2", false),
      toolUseTurn("search-3", "search"),
      toolResultTurn("search-3", true),
      toolUseTurn("search-current", "search"),
    ];
    const ctx = makeCtx(errorResponse("search-current"), messages);

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN coaching still fires — the success reset the streak below the cap.
    expect(ctx.additionalContext).toBe(TOOL_ERROR_NUDGE_TEXT);
  });

  test("counts failures per tool name, not globally", async () => {
    // GIVEN three failures of "other" and zero of "search" before the current
    // "search" failure — a global counter would be over the cap, but the
    // per-tool streak for "search" is just this one failure.
    const messages: Message[] = [
      toolUseTurn("other-0", "other"),
      toolResultTurn("other-0", true),
      toolUseTurn("other-1", "other"),
      toolResultTurn("other-1", true),
      toolUseTurn("other-2", "other"),
      toolResultTurn("other-2", true),
      toolUseTurn("search-current", "search"),
    ];
    const ctx = makeCtx(errorResponse("search-current"), messages);

    // WHEN the hook runs.
    await postToolUse(ctx);

    // THEN "search" is coached on its first failure.
    expect(ctx.additionalContext).toBe(TOOL_ERROR_NUDGE_TEXT);
  });
});

describe("tool-error post-tool-use hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin coaches an error result", async () => {
    // GIVEN the default tool-error plugin is registered.
    registerPlugin(defaultToolErrorPlugin);
    const { messages, currentToolUseId } = historyWithConsecutiveErrors(
      "search",
      0,
    );

    // WHEN the post-tool-use chain runs over an error result.
    const result = await runHook<PostToolUseContext>(
      HOOKS.POST_TOOL_USE,
      makeCtx(errorResponse(currentToolUseId), messages),
    );

    // THEN the coaching notice is surfaced via additionalContext.
    expect(result.additionalContext).toBe(TOOL_ERROR_NUDGE_TEXT);
  });

  test("default hook runs before a later-registered user hook", async () => {
    // GIVEN the default plugin is registered first, then a user plugin whose
    // hook records the additionalContext it observes.
    let observed: string | null | undefined;
    registerPlugin(defaultToolErrorPlugin);
    registerPlugin({
      manifest: { name: "observer-plugin", version: "0.0.1" },
      hooks: {
        "post-tool-use": async (ctx: PostToolUseContext) => {
          observed = ctx.additionalContext;
        },
      },
    });
    const { messages, currentToolUseId } = historyWithConsecutiveErrors(
      "search",
      0,
    );

    // WHEN the chain runs.
    await runHook<PostToolUseContext>(
      HOOKS.POST_TOOL_USE,
      makeCtx(errorResponse(currentToolUseId), messages),
    );

    // THEN the user hook saw the already-set additionalContext.
    expect(observed).toBe(TOOL_ERROR_NUDGE_TEXT);
  });
});
