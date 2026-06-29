/**
 * Tests for the default `task-progress-nudge` plugin's `post-tool-use` hook.
 *
 * Covers:
 * - Stays silent below the round threshold; nudges once a multi-step turn
 *   reaches it with no task_progress card shown.
 * - Never nudges when a task_progress card was already shown this turn.
 * - Fires at most once per turn (dedupes parallel results / further rounds).
 * - Resets across turns so a later multi-step turn can nudge again.
 * - Gating: fires only for the plugin's target model families on a mainAgent
 *   call site with a surface-capable client; skips non-target models,
 *   non-mainAgent call sites (background work and subagents), and channels
 *   without dynamic UI.
 * - Appends to (not overwrites) `additionalContext` set by an earlier hook.
 * - The nudge leaves the tool result's `content` untouched.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import postToolUse, {
  resetTaskProgressNudgeStateForTests,
  TASK_PROGRESS_NUDGE_ROUND_THRESHOLD,
  TASK_PROGRESS_NUDGE_TEXT,
} from "../plugins/defaults/task-progress-nudge/hooks/post-tool-use.js";
import type { Message, ToolResultContent } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let conversationCounter = 0;
function freshConversationId(): string {
  conversationCounter++;
  return `conv-nudge-test-${conversationCounter}`;
}

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

function toolResultTurn(toolUseId: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "ok",
        is_error: false,
      },
    ],
  };
}

function currentResponse(toolUseId: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: "result body",
    is_error: false,
  };
}

/** A model id matching NUDGE_TARGET_MODEL_PATTERN (the nudged population). */
const TARGET_MODEL = "minimax/minimax-m3";

function makeCtx(
  conversationId: string,
  toolResponse: ToolResultContent,
  messages: Message[],
  opts: {
    callSite?: PostToolUseContext["callSite"];
    model?: string;
    supportsDynamicUi?: boolean;
  } = {},
): PostToolUseContext {
  return {
    conversationId,
    toolResponse,
    messages,
    additionalContext: null,
    model: opts.model ?? TARGET_MODEL,
    maxInputTokens: 10_000,
    callSite: opts.callSite ?? "mainAgent",
    supportsDynamicUi: opts.supportsDynamicUi ?? true,
    logger: noopLogger,
  };
}

/**
 * Build a turn of `rounds` tool-use rounds. The last round's tool_use has no
 * result in history (it arrives via `ctx.toolResponse`). When `showCardAtRound`
 * is set, that round issues a `ui_show` task_progress card instead of a plain
 * tool.
 */
function turnWithRounds(
  rounds: number,
  opts: { showCardAtRound?: number } = {},
): { messages: Message[]; currentToolUseId: string } {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "build the thing" }] },
  ];
  for (let r = 1; r <= rounds; r++) {
    const id = `tool-${r}`;
    if (opts.showCardAtRound === r) {
      messages.push(
        toolUseTurn(id, "ui_show", {
          surface_type: "card",
          template: "task_progress",
          templateData: { status: "in_progress", steps: [] },
        }),
      );
    } else {
      messages.push(toolUseTurn(id, "bash", { command: `cmd-${r}` }));
    }
    if (r < rounds) messages.push(toolResultTurn(id));
  }
  return { messages, currentToolUseId: `tool-${rounds}` };
}

describe("task-progress-nudge post-tool-use hook", () => {
  beforeEach(() => {
    resetTaskProgressNudgeStateForTests();
  });

  test("stays silent below the round threshold", async () => {
    const { messages, currentToolUseId } = turnWithRounds(
      TASK_PROGRESS_NUDGE_ROUND_THRESHOLD - 1,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
  });

  test("nudges once the turn reaches the threshold with no card shown", async () => {
    const { messages, currentToolUseId } = turnWithRounds(
      TASK_PROGRESS_NUDGE_ROUND_THRESHOLD,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBe(TASK_PROGRESS_NUDGE_TEXT);
    // tool result content is untouched
    expect(ctx.toolResponse.content).toBe("result body");
  });

  test("never nudges when a task_progress card was already shown this turn", async () => {
    const { messages, currentToolUseId } = turnWithRounds(
      TASK_PROGRESS_NUDGE_ROUND_THRESHOLD + 2,
      { showCardAtRound: 1 },
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
  });

  test("fires at most once per turn", async () => {
    const conversationId = freshConversationId();
    const first = turnWithRounds(TASK_PROGRESS_NUDGE_ROUND_THRESHOLD);
    const ctx1 = makeCtx(
      conversationId,
      currentResponse(first.currentToolUseId),
      first.messages,
    );
    await postToolUse(ctx1);
    expect(ctx1.additionalContext).toBe(TASK_PROGRESS_NUDGE_TEXT);

    // One more round, still no card — must not nudge again this turn.
    const second = turnWithRounds(TASK_PROGRESS_NUDGE_ROUND_THRESHOLD + 1);
    const ctx2 = makeCtx(
      conversationId,
      currentResponse(second.currentToolUseId),
      second.messages,
    );
    await postToolUse(ctx2);
    expect(ctx2.additionalContext).toBeNull();
  });

  test("resets across turns so a later multi-step turn nudges again", async () => {
    const conversationId = freshConversationId();
    const first = turnWithRounds(TASK_PROGRESS_NUDGE_ROUND_THRESHOLD);
    const ctx1 = makeCtx(
      conversationId,
      currentResponse(first.currentToolUseId),
      first.messages,
    );
    await postToolUse(ctx1);
    expect(ctx1.additionalContext).toBe(TASK_PROGRESS_NUDGE_TEXT);

    // A brand-new turn (counting restarts low) below threshold — resets state.
    const lull = turnWithRounds(1);
    const ctxLull = makeCtx(
      conversationId,
      currentResponse(lull.currentToolUseId),
      lull.messages,
    );
    await postToolUse(ctxLull);
    expect(ctxLull.additionalContext).toBeNull();

    // Another multi-step turn — should nudge again.
    const third = turnWithRounds(TASK_PROGRESS_NUDGE_ROUND_THRESHOLD);
    const ctx3 = makeCtx(
      conversationId,
      currentResponse(third.currentToolUseId),
      third.messages,
    );
    await postToolUse(ctx3);
    expect(ctx3.additionalContext).toBe(TASK_PROGRESS_NUDGE_TEXT);
  });

  test("fires for the plugin's target model families", async () => {
    for (const model of [
      "moonshotai/kimi-k2.6",
      "deepseek/deepseek-chat",
      "accounts/fireworks/models/minimax-m3",
      "z-ai/glm-4.6",
    ]) {
      const { messages, currentToolUseId } = turnWithRounds(
        TASK_PROGRESS_NUDGE_ROUND_THRESHOLD,
      );
      const ctx = makeCtx(
        freshConversationId(),
        currentResponse(currentToolUseId),
        messages,
        { model },
      );
      await postToolUse(ctx);
      expect(ctx.additionalContext).toBe(TASK_PROGRESS_NUDGE_TEXT);
    }
  });

  test("skips non-target models", async () => {
    for (const model of ["claude-opus-4-8", "gpt-5.5"]) {
      const { messages, currentToolUseId } = turnWithRounds(
        TASK_PROGRESS_NUDGE_ROUND_THRESHOLD + 2,
      );
      const ctx = makeCtx(
        freshConversationId(),
        currentResponse(currentToolUseId),
        messages,
        { model },
      );
      await postToolUse(ctx);
      expect(ctx.additionalContext).toBeNull();
    }
  });

  test("skips non-mainAgent call sites (background work and subagents)", async () => {
    for (const callSite of ["heartbeatAgent", "subagentSpawn"] as const) {
      const { messages, currentToolUseId } = turnWithRounds(
        TASK_PROGRESS_NUDGE_ROUND_THRESHOLD,
      );
      const ctx = makeCtx(
        freshConversationId(),
        currentResponse(currentToolUseId),
        messages,
        { callSite },
      );
      await postToolUse(ctx);
      expect(ctx.additionalContext).toBeNull();
    }
  });

  test("skips channels that cannot render dynamic UI surfaces", async () => {
    const { messages, currentToolUseId } = turnWithRounds(
      TASK_PROGRESS_NUDGE_ROUND_THRESHOLD + 2,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
      { supportsDynamicUi: false }, // e.g. SMS/phone/email — ui_show is filtered out
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
  });

  test("appends to existing additionalContext rather than overwriting", async () => {
    const { messages, currentToolUseId } = turnWithRounds(
      TASK_PROGRESS_NUDGE_ROUND_THRESHOLD,
    );
    const ctx = makeCtx(
      freshConversationId(),
      currentResponse(currentToolUseId),
      messages,
    );
    ctx.additionalContext = "<system_notice>prior coaching</system_notice>";
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBe(
      `<system_notice>prior coaching</system_notice>\n${TASK_PROGRESS_NUDGE_TEXT}`,
    );
  });
});
