/**
 * Tests for the default `exploration-drift` plugin's `post-tool-use` hook.
 *
 * Covers:
 * - The hook surfaces the canonical nudge via `additionalContext` (leaving the
 *   tool result's `content` untouched) once a turn accumulates an unbroken
 *   threshold-length run of exploration tool calls, and stays silent below it.
 * - The streak is bounded by a real user message, a non-empty assistant text
 *   block, and a non-exploration tool result.
 * - Repeat nudges are spaced one full threshold apart per conversation.
 * - Subagent conversations are exempt.
 * - The nudge appends to (not overwrites) `additionalContext` set by an
 *   earlier hook in the chain (e.g. tool-error coaching).
 * - End-to-end through `runHook` + the registry.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the subagent manager before importing the hook — the hook lazily
// imports it on the nudge path to exempt subagent conversations.
let mockParentInfo: (conversationId: string) => unknown = () => undefined;
mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({
    getParentInfo: (conversationId: string) => mockParentInfo(conversationId),
  }),
}));

import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import postToolUse, {
  EXPLORATION_DRIFT_NUDGE_TEXT,
  EXPLORATION_NUDGE_THRESHOLD,
  resetExplorationDriftStateForTests,
} from "../plugins/defaults/exploration-drift/hooks/post-tool-use.js";
import { defaultExplorationDriftPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message, ToolResultContent } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const BASE_CONTENT = "grep output";

let conversationCounter = 0;
/** Unique conversation id per test so the per-conversation state can't leak. */
function freshConversationId(): string {
  conversationCounter++;
  return `conv-drift-test-${conversationCounter}`;
}

/** Assistant turn issuing a single `tool_use` block. */
function toolUseTurn(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

/** User turn carrying a single `tool_result` for a prior `tool_use`. */
function toolResultTurn(toolUseId: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "result",
        is_error: false,
      },
    ],
  };
}

function currentResponse(toolUseId: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: BASE_CONTENT,
    is_error: false,
  };
}

function makeCtx(
  conversationId: string,
  toolResponse: ToolResultContent,
  messages: Message[],
): PostToolUseContext {
  return {
    conversationId,
    toolResponse,
    messages,
    additionalContext: null,
    maxInputTokens: 10_000,
    logger: noopLogger,
  };
}

/**
 * Build a history of `priorCalls` completed exploration tool calls of
 * `toolName`, followed by the current turn's `tool_use` (whose result is
 * delivered via `ctx.toolResponse`, not history).
 */
function explorationHistory(
  priorCalls: number,
  toolName = "bash",
): { messages: Message[]; currentToolUseId: string } {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "investigate the bug" }] },
  ];
  for (let i = 0; i < priorCalls; i++) {
    const id = `${toolName}-${i}`;
    messages.push(toolUseTurn(id, toolName));
    messages.push(toolResultTurn(id));
  }
  const currentToolUseId = `${toolName}-current`;
  messages.push(toolUseTurn(currentToolUseId, toolName));
  return { messages, currentToolUseId };
}

beforeEach(() => {
  resetExplorationDriftStateForTests();
  mockParentInfo = () => undefined;
});

describe("exploration-drift post-tool-use hook — direct", () => {
  test("stays silent below the threshold", async () => {
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 2,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
    expect(ctx.toolResponse.content).toBe(BASE_CONTENT);
  });

  test("nudges once the streak reaches the threshold, leaving the result untouched", async () => {
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
    expect(ctx.toolResponse.content).toBe(BASE_CONTENT);
  });

  test("counts file_read and file_list as exploration tools", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < EXPLORATION_NUDGE_THRESHOLD - 1; i++) {
      const name = i % 2 === 0 ? "file_read" : "file_list";
      const id = `${name}-${i}`;
      messages.push(toolUseTurn(id, name));
      messages.push(toolResultTurn(id));
    }
    messages.push(toolUseTurn("bash-current", "bash"));
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse("bash-current"),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
  });

  test("a non-empty assistant text block resets the streak", async () => {
    // GIVEN a long run interrupted by the model speaking to the user, with
    // fewer than threshold calls after the text.
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    messages.splice(messages.length - 1, 0, {
      role: "assistant",
      content: [{ type: "text", text: "Here is what I found so far…" }],
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("a non-exploration tool result breaks the streak", async () => {
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    // Replace the second-to-last completed call with a write tool.
    messages.splice(
      messages.length - 1,
      0,
      toolUseTurn("write-1", "file_write"),
      toolResultTurn("write-1"),
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("is a no-op when the current tool is not an exploration tool", async () => {
    const { messages } = explorationHistory(EXPLORATION_NUDGE_THRESHOLD * 2);
    messages.push(toolUseTurn("write-current", "file_write"));
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse("write-current"),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("repeat nudges are spaced one full threshold apart", async () => {
    const conversationId = freshConversationId();

    // First nudge at the threshold.
    const first = explorationHistory(EXPLORATION_NUDGE_THRESHOLD - 1);
    const firstCtx = makeCtx(
      conversationId,
      currentResponse(first.currentToolUseId),
      first.messages,
    );
    await postToolUse(firstCtx);
    expect(firstCtx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);

    // One more call right after — silent.
    const next = explorationHistory(EXPLORATION_NUDGE_THRESHOLD);
    const nextCtx = makeCtx(
      conversationId,
      currentResponse(next.currentToolUseId),
      next.messages,
    );
    await postToolUse(nextCtx);
    expect(nextCtx.additionalContext).toBeNull();

    // Another full threshold later — nudges again.
    const second = explorationHistory(EXPLORATION_NUDGE_THRESHOLD * 2 - 1);
    const secondCtx = makeCtx(
      conversationId,
      currentResponse(second.currentToolUseId),
      second.messages,
    );
    await postToolUse(secondCtx);
    expect(secondCtx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
  });

  test("a restarted streak (new turn) nudges at the threshold again", async () => {
    const conversationId = freshConversationId();

    // Fire once deep into a long run.
    const longRun = explorationHistory(EXPLORATION_NUDGE_THRESHOLD * 2 - 1);
    const longCtx = makeCtx(
      conversationId,
      currentResponse(longRun.currentToolUseId),
      longRun.messages,
    );
    await postToolUse(longCtx);
    expect(longCtx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);

    // A new turn starts (streak restarts from a fresh history) and runs to
    // the threshold — the stale high-water mark must not suppress this nudge.
    const newTurn = explorationHistory(EXPLORATION_NUDGE_THRESHOLD - 1);
    const newCtx = makeCtx(
      conversationId,
      currentResponse(newTurn.currentToolUseId),
      newTurn.messages,
    );
    await postToolUse(newCtx);
    expect(newCtx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
  });

  test("subagent conversations are exempt", async () => {
    mockParentInfo = () => ({
      parentConversationId: "parent-1",
      subagentId: "sub-1",
      label: "investigate-empty-turns",
      parentSendToClient: () => {},
    });
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("appends to additionalContext set by an earlier hook", async () => {
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );
    ctx.additionalContext = "<system_notice>earlier coaching</system_notice>";

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(
      `<system_notice>earlier coaching</system_notice>\n${EXPLORATION_DRIFT_NUDGE_TEXT}`,
    );
  });
});

describe("exploration-drift post-tool-use hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin nudges a threshold-length run", async () => {
    registerPlugin(defaultExplorationDriftPlugin);
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );

    const result = await runHook<PostToolUseContext>(
      HOOKS.POST_TOOL_USE,
      makeCtx(
        freshConversationId(),
        currentResponse(currentToolUseId),
        messages,
      ),
    );

    expect(result.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
  });
});
