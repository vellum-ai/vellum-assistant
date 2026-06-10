/**
 * Tests for the default `empty-response` plugin's `stop` hook.
 *
 * Covers:
 * - The default hook's decision for the canonical cases: empty turn after a
 *   prior tool-use turn → continue (with the canonical nudge text); visible
 *   text → stop; prior turn already delivered visible text → stop; first model
 *   call with no prior turn → stop; provider refusal → stop with the turn
 *   rewritten to the user-facing fallback; refusal-but-recovered → stop;
 *   refusal after a visible reply this run → stop with no rewrite.
 * - The hook scopes its prior-turn signals to the current response cycle (the
 *   messages after the last genuine user prompt), so visible text from the
 *   inbound conversation does not suppress the nudge.
 * - When the hook continues, it appends the nudge as a `user` message to
 *   `messages`.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire, and a later-registered user hook chains after
 *   it and can read/override the decision.
 *
 * The loop's actual side-effects (retry-budget cap, history splice, log
 * emission) live in `agent/loop.ts` and are covered by integration tests in
 * `conversation-agent-loop.test.ts` / `agent-loop.test.ts`. This file isolates
 * the hook.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, StopContext } from "../plugin-api/types.js";
import {
  NUDGE_TEXT,
  REFUSAL_FALLBACK_TEXT,
} from "../plugins/defaults/empty-response/hooks/stop.js";
import stop from "../plugins/defaults/empty-response/hooks/stop.js";
import { defaultEmptyResponsePlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const emptyTextBlock: ContentBlock = { type: "text", text: "   " };

/** A prior assistant turn that issued a tool call but no visible text. */
const priorToolUseTurn: Message = {
  role: "assistant",
  content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: {} }],
};

/** A prior assistant turn that delivered visible text to the user. */
const priorVisibleTextTurn: Message = {
  role: "assistant",
  content: [{ type: "text", text: "here is what I found earlier" }],
};

/** A genuine user prompt — the boundary that opens a new response cycle. */
function userPrompt(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-stop",
    messages: [],
    responseContent: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    ...overrides,
  };
}

// ─── Default decisions ───────────────────────────────────────────────────────

describe("empty-response stop hook — default decisions", () => {
  test("empty turn after a prior tool-use turn → continue with canonical nudge", async () => {
    // GIVEN a run that already issued a tool call, then returned an empty
    // (whitespace-only) assistant turn with no visible text.
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      responseContent: [emptyTextBlock],
    });

    // WHEN the default stop hook runs.
    await stop(ctx);

    // THEN it asks the loop to continue and appends the canonical nudge.
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: NUDGE_TEXT }],
    });
  });

  test("turn contains visible text → stop", async () => {
    // GIVEN a turn that delivered visible text.
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      responseContent: [{ type: "text", text: "here is a summary" }],
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the decision stays at stop and nothing is appended.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  test("prior turn already delivered visible text → stop", async () => {
    // GIVEN the model said its piece in an earlier turn this run, then ended
    // with a side-effect tool and returned empty. Nudging would force a
    // verbatim re-send of text the user already saw.
    const ctx = makeCtx({
      messages: [userPrompt("do X"), priorVisibleTextTurn, priorToolUseTurn],
      responseContent: [],
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the decision stays at stop.
    expect(ctx.decision).toBe("stop");
  });

  test("visible text before the last user prompt is ignored → continue", async () => {
    // GIVEN the inbound conversation already contains an assistant turn with
    // visible text, but it precedes this run's user prompt. The current cycle
    // (after that prompt) holds only a tool-use turn, so the earlier text
    // belongs to the prior conversation and must not suppress the nudge.
    const ctx = makeCtx({
      messages: [
        priorVisibleTextTurn,
        userPrompt("do the next thing"),
        priorToolUseTurn,
      ],
      responseContent: [],
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it continues — the cycle scope sees only the tool-use turn, not the
    // inbound conversation's visible text.
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: NUDGE_TEXT }],
    });
  });

  test("first model call with no prior turn → stop", async () => {
    // GIVEN an empty first assistant response with no prior turn this run and
    // no refusal — not the pattern the organic-empty-turn nudge guards against.
    const ctx = makeCtx({ messages: [], responseContent: [] });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the decision stays at stop.
    expect(ctx.decision).toBe("stop");
  });

  // ─── Refusal stop ──────────────────────────────────────────────────────────

  test("refusal on the first call with no content → stop with rewritten fallback", async () => {
    // GIVEN the canonical failure mode: the provider's safety classifier zeros
    // the response on the very first model call, returning `stopReason:
    // "refusal"` and no visible text.
    const ctx = makeCtx({
      messages: [],
      responseContent: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it lets the turn end and rewrites the turn content to the
    // user-facing fallback, without nudging the model.
    expect(ctx.decision).toBe("stop");
    expect(ctx.responseContent).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
    expect(ctx.messages).toEqual([]);
  });

  test("refusal with a thinking-only block is still rewritten", async () => {
    // GIVEN a refusal whose only content is a thinking block — the user sees
    // nothing.
    const ctx = makeCtx({
      messages: [],
      responseContent: [
        { type: "thinking", thinking: "...", signature: "sig" },
      ],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it stops and rewrites the turn content to the fallback.
    expect(ctx.decision).toBe("stop");
    expect(ctx.responseContent).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
  });

  test("refusal but visible text present → stop, no rewrite (model recovered)", async () => {
    // GIVEN a refusal that still delivered some visible text before refusing —
    // the user has something to see.
    const ctx = makeCtx({
      responseContent: [{ type: "text", text: "partial answer" }],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the decision stays at stop and the turn content is left untouched.
    expect(ctx.decision).toBe("stop");
    expect(ctx.responseContent).toEqual([
      { type: "text", text: "partial answer" },
    ]);
  });

  test("refusal after a visible reply this run → stop, no rewrite", async () => {
    // GIVEN an earlier turn this run already delivered a real answer (text
    // alongside a tool call), then the trailing turn refuses after the tool
    // result. Rewriting here would stack an apology beneath the real answer.
    const ctx = makeCtx({
      messages: [userPrompt("do X"), priorVisibleTextTurn, priorToolUseTurn],
      responseContent: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the refusal is left as-is — no fallback is stacked beneath the
    // earlier reply.
    expect(ctx.decision).toBe("stop");
    expect(ctx.responseContent).toEqual([]);
  });

  test("refusal beats the post-tool-empty nudge", async () => {
    // GIVEN conditions that would trip both the refusal branch and the
    // post-tool-empty branch (a prior tool-use turn with no visible text).
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      responseContent: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN refusal wins: the turn content is rewritten to the fallback and the
    // model is not nudged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.responseContent).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });
});

// ─── Via runHook + registry ──────────────────────────────────────────────────

describe("empty-response stop hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin makes the hook continue on empty-after-tools", async () => {
    // GIVEN the default empty-response plugin is registered.
    registerPlugin(defaultEmptyResponsePlugin);

    // WHEN the stop chain runs over an empty-after-tools context.
    const result = await runHook<StopContext>(
      HOOKS.STOP,
      makeCtx({ messages: [priorToolUseTurn], responseContent: [] }),
    );

    // THEN the chain settles on continue with the canonical nudge appended.
    expect(result.decision).toBe("continue");
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: NUDGE_TEXT }],
    });
  });

  test("a later-registered user hook can override the default decision", async () => {
    // GIVEN the default plugin registers first, then a user plugin whose hook
    // observes the default's decision and forces a stop.
    let observedDecision: string | null = null;
    registerPlugin(defaultEmptyResponsePlugin);
    registerPlugin({
      manifest: { name: "force-stop", version: "0.0.1" },
      hooks: {
        stop: async (ctx: StopContext) => {
          observedDecision = ctx.decision;
          ctx.decision = "stop";
        },
      },
    });

    // WHEN the chain runs over an empty-after-tools context.
    const result = await runHook<StopContext>(
      HOOKS.STOP,
      makeCtx({ messages: [priorToolUseTurn], responseContent: [] }),
    );

    // THEN the user hook saw the default's continue, and its override wins.
    expect(observedDecision as string | null).toBe("continue");
    expect(result.decision).toBe("stop");
  });
});
