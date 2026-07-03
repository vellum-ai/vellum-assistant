/**
 * Tests for the default `empty-response` plugin's hooks.
 *
 * Covers:
 * - The `post-model-call` hook's decision for the canonical cases: empty turn
 *   after a prior tool-use turn → continue (with the canonical nudge text);
 *   visible text → stop; prior turn already delivered visible text → stop;
 *   first model call with no prior turn → stop; provider refusal → stop with
 *   the turn rewritten to the user-facing fallback; refusal-but-recovered →
 *   stop; refusal after a visible reply this run → stop with no rewrite.
 * - The hook scopes its prior-turn signals to the current response cycle (the
 *   messages after the last genuine user prompt), so visible text from the
 *   inbound conversation does not suppress the nudge.
 * - When the hook continues, it appends the nudge as a `user` message to
 *   `messages`.
 * - The retry bound is split across the two hooks: `post-model-call` marks the
 *   bound (nudging at most once per run) and the `stop` hook clears it on the
 *   definitive terminal so the next run nudges afresh.
 * - The hook ignores outcomes it does not own: a provider rejection (it carries
 *   an `error`) and a tool-bearing turn (the loop continues on its own).
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire, and a later-registered user hook chains after
 *   it and can read/override the decision.
 *
 * The loop's actual side-effects (per-run backstop, history splice, streamed
 * output) live in `agent/loop.ts` and are covered by integration tests in
 * `conversation-agent-loop.test.ts` / `agent-loop.test.ts`. This file isolates
 * the hook.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  PostModelCallContext,
  StopContext,
} from "../plugin-api/types.js";
import {
  NUDGE_TEXT,
  REFUSAL_FALLBACK_TEXT,
} from "../plugins/defaults/empty-response/hooks/post-model-call.js";
import postModelCall from "../plugins/defaults/empty-response/hooks/post-model-call.js";
import stop from "../plugins/defaults/empty-response/hooks/stop.js";
import {
  isEmptyResponseNudged,
  markEmptyResponseNudged,
  resetEmptyResponseNudgeStoreForTests,
} from "../plugins/defaults/empty-response/nudge-state-store.js";
import { getAllDefaultPlugins } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { ContentBlock, Message } from "../providers/types.js";

const defaultEmptyResponsePlugin = getAllDefaultPlugins().find(
  (p) => p.manifest.name === "default-empty-response",
)!;

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

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-pmc",
    callSite: "mainAgent",
    content: [],
    messages: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    ...overrides,
  };
}

beforeEach(() => {
  resetEmptyResponseNudgeStoreForTests();
});

// ─── Default decisions ───────────────────────────────────────────────────────

describe("empty-response post-model-call hook — default decisions", () => {
  test("empty turn after a prior tool-use turn → continue with canonical nudge", async () => {
    // GIVEN a run that already issued a tool call, then returned an empty
    // (whitespace-only) assistant turn with no visible text.
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      content: [emptyTextBlock],
    });

    // WHEN the default post-model-call hook runs.
    await postModelCall(ctx);

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
      content: [{ type: "text", text: "here is a summary" }],
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays at stop and nothing is appended.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  test("tool-bearing turn is ignored — no nudge, no rewrite", async () => {
    // GIVEN a turn that carries a tool call (the loop continues on its own to
    // run the tool, so the retry decision is not the hook's to make).
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      content: [{ type: "tool_use", id: "tu_2", name: "read_file", input: {} }],
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it leaves the decision and history untouched.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  test("prior turn already delivered visible text → stop", async () => {
    // GIVEN the model said its piece in an earlier turn this run, then ended
    // with a side-effect tool and returned empty. Nudging would force a
    // verbatim re-send of text the user already saw.
    const ctx = makeCtx({
      messages: [userPrompt("do X"), priorVisibleTextTurn, priorToolUseTurn],
      content: [],
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

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
      content: [],
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

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
    const ctx = makeCtx({ messages: [], content: [] });

    // WHEN the hook runs.
    await postModelCall(ctx);

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
      content: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it lets the turn end and rewrites the turn content to the
    // user-facing fallback, without nudging the model.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
    expect(ctx.messages).toEqual([]);
  });

  test("refusal with a thinking-only block is still rewritten", async () => {
    // GIVEN a refusal whose only content is a thinking block — the user sees
    // nothing.
    const ctx = makeCtx({
      messages: [],
      content: [{ type: "thinking", thinking: "...", signature: "sig" }],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it stops and rewrites the turn content to the fallback.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
  });

  test("refusal but visible text present → stop, no rewrite (model recovered)", async () => {
    // GIVEN a refusal that still delivered some visible text before refusing —
    // the user has something to see.
    const ctx = makeCtx({
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the decision stays at stop and the turn content is left untouched.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([{ type: "text", text: "partial answer" }]);
  });

  test("refusal after a visible reply this run → stop, no rewrite", async () => {
    // GIVEN an earlier turn this run already delivered a real answer (text
    // alongside a tool call), then the trailing turn refuses after the tool
    // result. Rewriting here would stack an apology beneath the real answer.
    const ctx = makeCtx({
      messages: [userPrompt("do X"), priorVisibleTextTurn, priorToolUseTurn],
      content: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the refusal is left as-is — no fallback is stacked beneath the
    // earlier reply.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([]);
  });

  test("refusal beats the post-tool-empty nudge", async () => {
    // GIVEN conditions that would trip both the refusal branch and the
    // post-tool-empty branch (a prior tool-use turn with no visible text).
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      content: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN refusal wins: the turn content is rewritten to the fallback and the
    // model is not nudged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  test("provider rejection is ignored — no nudge, no rewrite", async () => {
    // GIVEN a rejection outcome (the call threw before any reply existed). The
    // shape otherwise matches the post-tool-empty nudge case, but no response
    // was produced, so this plugin defers to the recovery hooks.
    const ctx = makeCtx({
      messages: [priorToolUseTurn],
      content: [],
      error: new Error("provider rejected the request"),
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it leaves the decision and history untouched — empty-response only
    // acts on a finalized (successful) reply.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  // ─── Call-site gating ──────────────────────────────────────────────────────

  test("empty turn after tools on a non-mainAgent call site → stop, no nudge", async () => {
    // GIVEN an empty-after-tools turn that would nudge on the user-facing reply,
    // but the call site is a background one (a memory retrospective). There is
    // no user awaiting a summary, so the re-query nudge must not fire.
    const ctx = makeCtx({
      callSite: "memoryRetrospective",
      messages: [priorToolUseTurn],
      content: [],
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the turn ends silently — no nudge appended, no re-query.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorToolUseTurn]);
  });

  test("refusal on a non-mainAgent call site is still rewritten to the fallback", async () => {
    // GIVEN a refusal with no visible text on a background call site. The
    // call-site gate scopes only the re-query nudge; the refusal-rewrite is a
    // user-facing terminal fallback for any consumer that reads the final text,
    // so it stays ungated.
    const ctx = makeCtx({
      callSite: "memoryRetrospective",
      messages: [],
      content: [],
      stopReason: "refusal",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the empty refusal is still rewritten to the user-facing fallback.
    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual([
      { type: "text", text: REFUSAL_FALLBACK_TEXT },
    ]);
  });
});

// ─── One-shot retry bound ────────────────────────────────────────────────────

describe("empty-response post-model-call hook — one-shot bound", () => {
  test("a second empty turn this run is not nudged again", async () => {
    // GIVEN the hook already nudged once this run for the conversation.
    const first = makeCtx({
      conversationId: "conv-bound",
      messages: [priorToolUseTurn],
      content: [],
    });
    await postModelCall(first);
    expect(first.decision).toBe("continue");

    // WHEN a second empty-after-tools turn arrives for the same conversation.
    const second = makeCtx({
      conversationId: "conv-bound",
      messages: [priorToolUseTurn],
      content: [],
    });
    await postModelCall(second);

    // THEN the hook lets the turn end rather than nudging again.
    expect(second.decision).toBe("stop");
    expect(second.messages).toEqual([priorToolUseTurn]);
  });

  test("the hook never clears its own bound — clearing is the stop hook's job", async () => {
    // GIVEN the hook nudged once this run for the conversation.
    const nudged = makeCtx({
      conversationId: "conv-no-self-clear",
      messages: [priorToolUseTurn],
      content: [],
    });
    await postModelCall(nudged);

    // WHEN the re-queried call comes back as a provider rejection, then as a
    // recovered visible-text reply — outcomes that end the turn.
    await postModelCall(
      makeCtx({
        conversationId: "conv-no-self-clear",
        messages: [priorToolUseTurn],
        content: [],
        error: new Error("provider rejected the request"),
      }),
    );
    await postModelCall(
      makeCtx({
        conversationId: "conv-no-self-clear",
        messages: [priorToolUseTurn],
        content: [{ type: "text", text: "here is the summary" }],
      }),
    );

    // THEN the bound stays marked — `post-model-call` only ever marks; the
    // sibling `stop` hook is what clears it at the turn boundary.
    expect(isEmptyResponseNudged("conv-no-self-clear")).toBe(true);
  });
});

// ─── stop hook (terminal cleanup) ────────────────────────────────────────────

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-stop",
    messages: [],
    exitReason: "no_tool_calls",
    logger: noopLogger,
    ...overrides,
  };
}

describe("empty-response stop hook — terminal cleanup", () => {
  test("a terminal stop clears the nudge bound", async () => {
    // GIVEN a conversation that nudged this run.
    const conversationId = "conv-stop-clear";
    markEmptyResponseNudged(conversationId);

    // WHEN the terminal stop hook runs.
    await stop(makeStopCtx({ conversationId }));

    // THEN the bound is cleared so the next run nudges afresh.
    expect(isEmptyResponseNudged(conversationId)).toBe(false);
  });

  test("clears the bound regardless of how the turn ended", async () => {
    // GIVEN a conversation that nudged this run, ending on an abort rather than
    // a finalized reply.
    const conversationId = "conv-stop-abort";
    markEmptyResponseNudged(conversationId);

    // WHEN the terminal stop hook runs for that exit.
    await stop(makeStopCtx({ conversationId, exitReason: "aborted_pre_call" }));

    // THEN the bound is still cleared — `stop` is the definitive terminal, so
    // the next run always nudges afresh.
    expect(isEmptyResponseNudged(conversationId)).toBe(false);
  });
});

// ─── Via runHook + registry ──────────────────────────────────────────────────

describe("empty-response post-model-call hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin makes the hook continue on empty-after-tools", async () => {
    // GIVEN the default empty-response plugin is registered.
    registerPlugin(defaultEmptyResponsePlugin);

    // WHEN the post-model-call chain runs over an empty-after-tools context.
    const result = await runHook<PostModelCallContext>(
      HOOKS.POST_MODEL_CALL,
      makeCtx({ messages: [priorToolUseTurn], content: [] }),
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
        "post-model-call": async (ctx: PostModelCallContext) => {
          observedDecision = ctx.decision;
          ctx.decision = "stop";
        },
      },
    });

    // WHEN the chain runs over an empty-after-tools context.
    const result = await runHook<PostModelCallContext>(
      HOOKS.POST_MODEL_CALL,
      makeCtx({ messages: [priorToolUseTurn], content: [] }),
    );

    // THEN the user hook saw the default's continue, and its override wins.
    expect(observedDecision as string | null).toBe("continue");
    expect(result.decision).toBe("stop");
  });
});
