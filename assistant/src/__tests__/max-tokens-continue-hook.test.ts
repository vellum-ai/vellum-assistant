/**
 * Tests for the default `max-tokens-continue` plugin's hooks.
 *
 * Covers:
 * - The `post-model-call` hook's decision for the canonical cases: a
 *   main-agent turn truncated at the output token limit → continue, with the
 *   truncated turn and the canonical continuation nudge appended to
 *   `messages`; any other stop reason → stop; non-main-agent call sites →
 *   stop; a provider rejection → stop; an entirely-stripped (empty) truncated
 *   turn → stop.
 * - The per-run budget is split across the two hooks: `post-model-call`
 *   consumes one unit per continue (up to `MAX_TOKENS_AUTO_CONTINUES`) and
 *   the `stop` hook clears the counter on the definitive terminal so the next
 *   run starts with a full budget.
 *
 * The loop's actual side-effects (keeping the partial turn, per-run backstop,
 * the continuation card on a terminal stop) live in `agent/loop.ts`. This
 * file isolates the hook.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { INTERNAL_NUDGE_OUTPUT_SUPPRESSION } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  PostModelCallContext,
  StopContext,
} from "../plugin-api/types.js";
import {
  hasMaxTokensContinueBudget,
  MAX_TOKENS_AUTO_CONTINUES,
  resetMaxTokensContinueStoreForTests,
} from "../plugins/defaults/max-tokens-continue/continue-state-store.js";
import postModelCall, {
  MAX_TOKENS_CONTINUE_NUDGE_TEXT,
} from "../plugins/defaults/max-tokens-continue/hooks/post-model-call.js";
import stop from "../plugins/defaults/max-tokens-continue/hooks/stop.js";
import type { ContentBlock } from "../providers/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const truncatedText: ContentBlock = {
  type: "text",
  text: "Here is the start of a very long answer that got cut o",
};

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-mtc",
    callSite: "mainAgent",
    content: [truncatedText],
    messages: [{ role: "user", content: [{ type: "text", text: "build it" }] }],
    stopReason: "max_tokens",
    decision: "stop",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetMaxTokensContinueStoreForTests();
});

// ─── Decisions ───────────────────────────────────────────────────────────────

describe("max-tokens-continue NUDGE_TEXT — internal-notice suppression", () => {
  test("appends the shared suppression clause inside the notice wrapper", () => {
    expect(MAX_TOKENS_CONTINUE_NUDGE_TEXT).toContain(
      INTERNAL_NUDGE_OUTPUT_SUPPRESSION,
    );
    expect(MAX_TOKENS_CONTINUE_NUDGE_TEXT.startsWith("<system_notice>")).toBe(
      true,
    );
    expect(MAX_TOKENS_CONTINUE_NUDGE_TEXT.endsWith("</system_notice>")).toBe(
      true,
    );
    // The continue instruction still leads (a truncated turn has content).
    expect(MAX_TOKENS_CONTINUE_NUDGE_TEXT).toContain(
      "Continue exactly where you stopped",
    );
  });
});

describe("max-tokens-continue post-model-call hook", () => {
  test("truncated main-agent turn → continue with the turn and nudge appended", async () => {
    /**
     * Tests that a max_tokens stop on a main-agent turn auto-continues.
     */
    // GIVEN a main-agent turn that stopped at the output token limit.
    const ctx = makeCtx();
    const priorLength = ctx.messages.length;

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it asks the loop to continue.
    expect(ctx.decision).toBe("continue");
    // AND it appends the truncated assistant turn followed by the nudge.
    expect(ctx.messages).toHaveLength(priorLength + 2);
    expect(ctx.messages[priorLength]).toEqual({
      role: "assistant",
      content: [truncatedText],
    });
    expect(ctx.messages[priorLength + 1]).toEqual({
      role: "user",
      content: [{ type: "text", text: MAX_TOKENS_CONTINUE_NUDGE_TEXT }],
    });
  });

  test("non-max-tokens stop reason → stop", async () => {
    /**
     * Tests that ordinary stop reasons are left alone.
     */
    // GIVEN a turn that ended normally.
    const ctx = makeCtx({ stopReason: "end_turn" });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays stop and messages are untouched.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toHaveLength(1);
  });

  test("non-mainAgent call site → stop", async () => {
    /**
     * Tests that background/subagent calls are never auto-continued.
     */
    // GIVEN a truncated turn on a non-main-agent call site.
    const ctx = makeCtx({ callSite: "recall" });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays stop.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toHaveLength(1);
  });

  test("provider rejection → stop", async () => {
    /**
     * Tests that a rejection outcome (no reply content) is ignored.
     */
    // GIVEN a provider rejection carrying an error.
    const ctx = makeCtx({ error: new Error("boom"), content: [] });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays stop.
    expect(ctx.decision).toBe("stop");
  });

  test("empty truncated content → stop", async () => {
    /**
     * Tests that a turn with nothing left after truncation-block stripping
     * ends terminally rather than pushing an empty assistant message.
     */
    // GIVEN a max_tokens stop whose safe content is empty.
    const ctx = makeCtx({ content: [] });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays stop and nothing is appended.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toHaveLength(1);
  });

  test("budget exhausts after MAX_TOKENS_AUTO_CONTINUES and stop hook resets it", async () => {
    /**
     * Tests the per-run continue budget and its reset on the terminal stop.
     */
    // GIVEN the budget is consumed by repeated truncated turns.
    for (let i = 0; i < MAX_TOKENS_AUTO_CONTINUES; i++) {
      const ctx = makeCtx();
      await postModelCall(ctx);
      expect(ctx.decision).toBe("continue");
    }
    expect(hasMaxTokensContinueBudget("conv-mtc")).toBe(false);

    // WHEN one more truncated turn arrives.
    const exhausted = makeCtx();
    await postModelCall(exhausted);

    // THEN the hook lets the turn end.
    expect(exhausted.decision).toBe("stop");
    expect(exhausted.messages).toHaveLength(1);

    // AND the stop hook clears the budget so the next run continues afresh.
    await stop({ conversationId: "conv-mtc" } as StopContext);
    expect(hasMaxTokensContinueBudget("conv-mtc")).toBe(true);
  });
});
