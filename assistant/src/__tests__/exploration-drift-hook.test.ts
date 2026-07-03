/**
 * Tests for the default `exploration-drift` plugin's `post-tool-use` hook.
 *
 * Covers:
 * - The hook surfaces the canonical long-dig nudge via `additionalContext`
 *   (leaving the tool result's `content` untouched) once a turn accumulates an
 *   unbroken threshold-length run of exploration tool calls, and stays silent
 *   below it.
 * - The loop trigger: on loop-prone models (Kimi K2.6, MiniMax M3),
 *   re-issuing a
 *   byte-identical exploration call fires a loop nudge well before the
 *   long-dig threshold; other models are unaffected; the signature comparison
 *   is key-order independent; the nudge re-fires on further duplicates and
 *   stops when the model moves on to fresh calls.
 * - The streak is bounded by a real user message, a non-empty assistant text
 *   block, and a non-exploration tool result.
 * - Repeat long-dig nudges are spaced one full threshold apart.
 * - Subagent conversations are exempt.
 * - The nudge appends to (not overwrites) `additionalContext` set by an
 *   earlier hook in the chain (e.g. tool-error coaching).
 * - End-to-end through `runHook` + the registry.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import postToolUse, {
  EXPLORATION_DRIFT_NUDGE_TEXT,
  EXPLORATION_LOOP_REPEAT_THRESHOLD,
  EXPLORATION_NUDGE_THRESHOLD,
  explorationLoopNudgeText,
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

/** A model id outside the loop-prone set. */
const GENERIC_MODEL = "claude-test-model";
/** Kimi K2.6 as reported by Fireworks. */
const KIMI_FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2p6";
/** Kimi K2.6 as reported by OpenRouter. */
const KIMI_OPENROUTER_MODEL = "moonshotai/kimi-k2.6";
/** MiniMax M3 as reported by OpenRouter. */
const MINIMAX_OPENROUTER_MODEL = "minimax/minimax-m3";

let conversationCounter = 0;
/** Unique conversation id per test so the per-conversation state can't leak. */
function freshConversationId(): string {
  conversationCounter++;
  return `conv-drift-test-${conversationCounter}`;
}

/** Assistant turn issuing a single `tool_use` block. */
function toolUseTurn(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
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
  model: string = GENERIC_MODEL,
  callSite: PostToolUseContext["callSite"] = "mainAgent",
): PostToolUseContext {
  return {
    conversationId,
    toolResponse,
    messages,
    additionalContext: null,
    model,
    maxInputTokens: 10_000,
    callSite,
    supportsDynamicUi: true,
    logger: noopLogger,
  };
}

/**
 * Build a history of `priorCalls` completed exploration tool calls of
 * `toolName` — each with a distinct input, so the loop trigger never fires on
 * histories meant to exercise the long-dig threshold — followed by the
 * current turn's `tool_use` (whose result is delivered via
 * `ctx.toolResponse`, not history).
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
    messages.push(toolUseTurn(id, toolName, { command: `cmd-${i}` }));
    messages.push(toolResultTurn(id));
  }
  const currentToolUseId = `${toolName}-current`;
  messages.push(
    toolUseTurn(currentToolUseId, toolName, { command: "cmd-current" }),
  );
  return { messages, currentToolUseId };
}

/**
 * Build a history where the current call repeats a prior call's exact input
 * `priorIdenticalCalls` times, padded in front with `distinctCalls` calls
 * with unique inputs.
 */
function repeatedCallHistory(opts: {
  priorIdenticalCalls: number;
  distinctCalls?: number;
  input?: Record<string, unknown>;
  currentInput?: Record<string, unknown>;
}): { messages: Message[]; currentToolUseId: string } {
  const repeatedInput = opts.input ?? { command: "grep -r needle src" };
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "investigate the bug" }] },
  ];
  for (let i = 0; i < (opts.distinctCalls ?? 0); i++) {
    const id = `distinct-${i}`;
    messages.push(toolUseTurn(id, "bash", { command: `unique-${i}` }));
    messages.push(toolResultTurn(id));
  }
  for (let i = 0; i < opts.priorIdenticalCalls; i++) {
    const id = `repeat-${i}`;
    messages.push(toolUseTurn(id, "bash", { ...repeatedInput }));
    messages.push(toolResultTurn(id));
  }
  const currentToolUseId = "repeat-current";
  messages.push(
    toolUseTurn(currentToolUseId, "bash", {
      ...(opts.currentInput ?? repeatedInput),
    }),
  );
  return { messages, currentToolUseId };
}

beforeEach(() => {
  resetExplorationDriftStateForTests();
});

describe("exploration-drift post-tool-use hook — long-dig trigger", () => {
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

  test("counts code_search, file_read, and file_list as exploration tools", async () => {
    const explorationNames = ["code_search", "file_read", "file_list"];
    const messages: Message[] = [];
    for (let i = 0; i < EXPLORATION_NUDGE_THRESHOLD - 1; i++) {
      const name = explorationNames[i % explorationNames.length];
      const id = `${name}-${i}`;
      messages.push(toolUseTurn(id, name, { path: `/tmp/file-${i}` }));
      messages.push(toolResultTurn(id));
    }
    messages.push(toolUseTurn("bash-current", "bash", { command: "ls" }));
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
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 1,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      GENERIC_MODEL,
      "subagentSpawn",
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

describe("exploration-drift post-tool-use hook — loop trigger", () => {
  test("fires on a loop-prone model when an identical call repeats to the threshold", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );
  });

  test("matches the OpenRouter Kimi K2.6 model id", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_OPENROUTER_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );
  });

  test("matches the MiniMax M3 model id", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      MINIMAX_OPENROUTER_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );
  });

  test("stays silent on other models for the same repeated-call history", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      GENERIC_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("stays silent below the repeat threshold", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 2,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("stays silent on a loop-prone model when calls are distinct", async () => {
    const { messages, currentToolUseId } = explorationHistory(
      EXPLORATION_NUDGE_THRESHOLD - 2,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("input signature comparison is key-order independent", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
      input: { command: "cat /tmp/log", timeout: 5 },
      currentInput: { timeout: 5, command: "cat /tmp/log" },
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );
  });

  test("re-fires on the next duplicate but not on the same streak twice", async () => {
    const conversationId = freshConversationId();

    // First loop nudge.
    const first = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const firstCtx = makeCtx(
      conversationId,
      currentResponse(first.currentToolUseId),
      first.messages,
      KIMI_FIREWORKS_MODEL,
    );
    await postToolUse(firstCtx);
    expect(firstCtx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );

    // A parallel sibling result observing the same history (same streak)
    // dedupes.
    const siblingCtx = makeCtx(
      conversationId,
      currentResponse(first.currentToolUseId),
      first.messages,
      KIMI_FIREWORKS_MODEL,
    );
    await postToolUse(siblingCtx);
    expect(siblingCtx.additionalContext).toBeNull();

    // The model ignores the nudge and issues the same call once more — the
    // streak grew by one, so the nudge re-fires with the higher count.
    const second = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD,
    });
    const secondCtx = makeCtx(
      conversationId,
      currentResponse(second.currentToolUseId),
      second.messages,
      KIMI_FIREWORKS_MODEL,
    );
    await postToolUse(secondCtx);
    expect(secondCtx.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD + 1),
    );
  });

  test("stops nudging once the model moves on to fresh calls", async () => {
    const conversationId = freshConversationId();

    const looped = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const loopedCtx = makeCtx(
      conversationId,
      currentResponse(looped.currentToolUseId),
      looped.messages,
      KIMI_FIREWORKS_MODEL,
    );
    await postToolUse(loopedCtx);
    expect(loopedCtx.additionalContext).not.toBeNull();

    // Next call has a fresh input — even though the duplicates remain in the
    // trailing run, the current call is not a repeat, so no loop nudge.
    const moved = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD,
      currentInput: { command: "a brand new command" },
    });
    const movedCtx = makeCtx(
      conversationId,
      currentResponse(moved.currentToolUseId),
      moved.messages,
      KIMI_FIREWORKS_MODEL,
    );
    await postToolUse(movedCtx);
    expect(movedCtx.additionalContext).toBeNull();
  });

  test("subagent conversations are exempt from the loop trigger", async () => {
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
    });
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
      "subagentSpawn",
    );

    await postToolUse(ctx);

    expect(ctx.additionalContext).toBeNull();
  });

  test("a long-dig-threshold run of identical calls uses the long-dig text once past the threshold", async () => {
    // When both triggers are eligible the long-dig path wins — by then the
    // generic guidance covers the loop case too.
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_NUDGE_THRESHOLD - 1,
    });
    const conversationId = freshConversationId();
    const ctx = makeCtx(
      conversationId,
      currentResponse(currentToolUseId),
      messages,
      KIMI_FIREWORKS_MODEL,
    );

    await postToolUse(ctx);

    // The loop trigger would have fired far earlier in a live run; with a
    // cold conversation state at threshold length, the long-dig text wins.
    expect(ctx.additionalContext).toBe(EXPLORATION_DRIFT_NUDGE_TEXT);
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

  test("registering the default plugin nudges a repeated call on Kimi K2.6", async () => {
    registerPlugin(defaultExplorationDriftPlugin);
    const { messages, currentToolUseId } = repeatedCallHistory({
      priorIdenticalCalls: EXPLORATION_LOOP_REPEAT_THRESHOLD - 1,
      distinctCalls: 2,
    });

    const result = await runHook<PostToolUseContext>(
      HOOKS.POST_TOOL_USE,
      makeCtx(
        freshConversationId(),
        currentResponse(currentToolUseId),
        messages,
        KIMI_FIREWORKS_MODEL,
      ),
    );

    expect(result.additionalContext).toBe(
      explorationLoopNudgeText("bash", EXPLORATION_LOOP_REPEAT_THRESHOLD),
    );
  });
});
