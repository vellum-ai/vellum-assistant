/**
 * Tests for the default `history-repair` plugin's hooks.
 *
 * `user-prompt-submit`:
 * - The hook normalizes `latestMessages` exactly as `repairHistory` would for
 *   the three documented repair classes (orphan tool_result, missing
 *   tool_result, consecutive same-role messages) and is a no-op for a
 *   well-formed history.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire and repair the working message list.
 * - Chain ordering: because defaults register first, the default repair hook
 *   runs ahead of a later-registered user hook, which therefore observes an
 *   already-normalized history.
 *
 * `post-model-call` (error-recovery):
 * - On a provider rejection carrying a repairable ordering error, the hook
 *   deep-repairs the messages and asks the loop to continue.
 * - Bounded to one pass per turn via the per-conversation repair state: a
 *   second consecutive ordering rejection is left to surface; the bound clears
 *   at the turn boundary.
 * - Leaves the bound intact across a mid-turn tool-bearing turn so a later
 *   ordering rejection is still the exhausted second attempt.
 * - Ignores non-ordering errors and finalized (non-error) replies.
 *
 * `stop` (terminal cleanup):
 * - Clears the repair bound on a terminal stop, covering the retry the loop's
 *   per-run backstop overrides — the one terminal `post-model-call` cannot
 *   resolve — so the next turn repairs afresh.
 * - Leaves the bound intact on a `"continue"` stop, where a hook is re-querying
 *   the model this turn.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  PostModelCallContext,
  StopContext,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import postModelCall from "../plugins/defaults/history-repair/hooks/post-model-call.js";
import stop from "../plugins/defaults/history-repair/hooks/stop.js";
import userPromptSubmit from "../plugins/defaults/history-repair/hooks/user-prompt-submit.js";
import {
  isOrderingRepairAttempted,
  markOrderingRepairAttempted,
  resetRepairStateStoreForTests,
} from "../plugins/defaults/history-repair/repair-state-store.js";
import {
  deepRepairHistory,
  repairHistory,
} from "../plugins/defaults/history-repair/terminal.js";
import { defaultHistoryRepairPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";

/** Provider rejection text matched by `isRepairableOrderingError`. */
const ORDERING_ERROR_MESSAGE =
  "messages: tool_use ids must have a corresponding tool_result";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(messages: Message[]): UserPromptSubmitContext {
  return {
    conversationId: "conv-test",
    userMessageId: "msg-test",
    requestId: "req-test",
    modelProfileKey: null,
    isNonInteractive: false,
    prompt: "",
    originalMessages: messages,
    latestMessages: messages,
    logger: noopLogger,
  };
}

/** Drift case covering all three repair classes at once. */
function driftedHistory(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Kick off" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
        { type: "tool_use", id: "tu_2", name: "read", input: { path: "/b" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    },
    { role: "user", content: [{ type: "text", text: "extra" }] },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ];
}

describe("history-repair user-prompt-submit hook — direct", () => {
  test("normalizes latestMessages identically to repairHistory", async () => {
    // GIVEN a history with an orphan tool_result, a missing tool_result, and
    // consecutive same-role messages.
    const messages = driftedHistory();
    const expected = repairHistory(messages);
    const ctx = makeCtx(messages);

    // WHEN the hook runs over the context.
    await userPromptSubmit(ctx);

    // THEN latestMessages matches the canonical repair output, and at least
    // one of each repair class fired (the case exercises all three).
    expect(ctx.latestMessages).toEqual(expected.messages);
    expect(expected.stats.missingToolResultsInserted).toBeGreaterThan(0);
    expect(expected.stats.consecutiveSameRoleMerged).toBeGreaterThan(0);
  });

  test("is a no-op for a well-formed history", async () => {
    // GIVEN a history that already satisfies the provider's pairing rules.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "contents" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Here." }] },
    ];
    const ctx = makeCtx(messages);

    // WHEN the hook runs.
    await userPromptSubmit(ctx);

    // THEN the history is unchanged.
    expect(ctx.latestMessages).toEqual(messages);
  });
});

describe("history-repair user-prompt-submit hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registering the default plugin repairs the working history", async () => {
    // GIVEN the default history-repair plugin is registered.
    registerPlugin(defaultHistoryRepairPlugin);
    const messages = driftedHistory();
    const expected = repairHistory(messages);

    // WHEN the user-prompt-submit chain runs.
    const result = await runHook<UserPromptSubmitContext>(
      HOOKS.USER_PROMPT_SUBMIT,
      makeCtx(messages),
    );

    // THEN the working history is normalized.
    expect(result.latestMessages).toEqual(expected.messages);
  });

  test("default repair hook runs before a later-registered user hook", async () => {
    // GIVEN the default plugin is registered first, then a user plugin whose
    // hook records the history it observes.
    let observed: Message[] | null = null;
    registerPlugin(defaultHistoryRepairPlugin);
    registerPlugin({
      manifest: { name: "observer-plugin", version: "0.0.1" },
      hooks: {
        "user-prompt-submit": async (ctx: UserPromptSubmitContext) => {
          observed = [...ctx.latestMessages];
        },
      },
    });
    const messages = driftedHistory();
    const expected = repairHistory(messages);

    // WHEN the chain runs.
    await runHook<UserPromptSubmitContext>(
      HOOKS.USER_PROMPT_SUBMIT,
      makeCtx(messages),
    );

    // THEN the user hook saw the already-repaired history.
    expect(observed as Message[] | null).toEqual(expected.messages);
  });
});

// ─── post-model-call hook (error-recovery) ───────────────────────────────────

/** An ordering-violating history: a leading assistant turn deep-repair strips. */
function orderingViolatingHistory(): Message[] {
  return [
    { role: "assistant", content: [{ type: "text", text: "orphaned" }] },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ];
}

function makePostModelCallCtx(
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

describe("history-repair post-model-call hook — direct", () => {
  beforeEach(() => {
    resetRepairStateStoreForTests();
  });

  test("repairable ordering error → deep-repairs and continues", async () => {
    // GIVEN a provider rejection carrying a repairable ordering error over a
    // history with a leading assistant turn.
    const messages = orderingViolatingHistory();
    const expected = deepRepairHistory(messages).messages;
    const ctx = makePostModelCallCtx({
      messages,
      error: new Error(ORDERING_ERROR_MESSAGE),
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it rewrites the messages to the deep-repaired history and asks the
    // loop to retry.
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages).toEqual(expected);
    expect(isOrderingRepairAttempted(ctx.conversationId)).toBe(true);
  });

  test("second consecutive ordering rejection is left to surface", async () => {
    // GIVEN a turn whose first ordering rejection already triggered a repair.
    const conversationId = "conv-bounded";
    markOrderingRepairAttempted(conversationId);
    const messages = orderingViolatingHistory();
    const ctx = makePostModelCallCtx({
      conversationId,
      messages,
      error: new Error(ORDERING_ERROR_MESSAGE),
    });

    // WHEN a second ordering rejection reaches the hook.
    await postModelCall(ctx);

    // THEN it does not repair again — the error surfaces.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);

    // AND the exhausted bound is cleared so the next turn repairs afresh.
    expect(isOrderingRepairAttempted(conversationId)).toBe(false);
  });

  test("a finalized reply clears the bound so a later turn repairs again", async () => {
    // GIVEN a conversation that already attempted a repair this turn.
    const conversationId = "conv-reset";
    markOrderingRepairAttempted(conversationId);

    // AND a finalized no-tool reply ends that turn, which the hook treats as
    // terminal.
    await postModelCall(
      makePostModelCallCtx({
        conversationId,
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      }),
    );
    expect(isOrderingRepairAttempted(conversationId)).toBe(false);

    // WHEN a later turn hits a repairable ordering rejection.
    const ctx = makePostModelCallCtx({
      conversationId,
      messages: orderingViolatingHistory(),
      error: new Error(ORDERING_ERROR_MESSAGE),
    });
    await postModelCall(ctx);

    // THEN the hook repairs independently of the prior turn.
    expect(ctx.decision).toBe("continue");
  });

  test("a non-ordering outcome already continuing this turn keeps the bound", async () => {
    // GIVEN this turn already repaired an ordering rejection (bound marked),
    // then an earlier hook recovered a different error and set the decision to
    // continue.
    const conversationId = "conv-cross-hook";
    markOrderingRepairAttempted(conversationId);
    const ctx = makePostModelCallCtx({
      conversationId,
      decision: "continue",
      error: new Error("image dimensions exceed max allowed size"),
    });

    // WHEN the history-repair hook runs after that earlier hook.
    await postModelCall(ctx);

    // THEN it leaves the in-flight continue alone and keeps its bound, so a
    // later ordering rejection in the same turn is recognized as the exhausted
    // second attempt rather than a fresh first one. The error retry shares the
    // loop's per-run backstop, but clearing here could let alternating
    // recoverable rejections reissue the provider call within that cap.
    expect(ctx.decision).toBe("continue");
    expect(isOrderingRepairAttempted(conversationId)).toBe(true);
  });

  test("a mid-turn tool-bearing turn keeps the bound", async () => {
    // GIVEN this turn already repaired an ordering rejection (bound marked),
    // then the model returned a tool-bearing turn the loop continues on its
    // own.
    const conversationId = "conv-tool-turn";
    markOrderingRepairAttempted(conversationId);
    const ctx = makePostModelCallCtx({
      conversationId,
      content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
    });

    // WHEN the hook runs over the tool-bearing turn.
    await postModelCall(ctx);

    // THEN it leaves the decision alone and keeps its bound, so a later
    // ordering rejection in the same turn is still the exhausted second
    // attempt.
    expect(ctx.decision).toBe("stop");
    expect(isOrderingRepairAttempted(conversationId)).toBe(true);
  });

  test("non-ordering error is left untouched", async () => {
    // GIVEN a provider rejection that is not an ordering violation.
    const messages = orderingViolatingHistory();
    const ctx = makePostModelCallCtx({
      messages,
      error: new Error("rate limit exceeded"),
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it defers — the decision and history are unchanged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });

  test("finalized (non-error) reply is ignored", async () => {
    // GIVEN a finalized reply — the model returned content, no error.
    const messages = orderingViolatingHistory();
    const ctx = makePostModelCallCtx({
      messages,
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the model response is left untouched — repair only applies to
    // ordering rejections.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });
});

// ─── stop hook (terminal cleanup) ────────────────────────────────────────────

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
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

describe("history-repair stop hook — direct", () => {
  beforeEach(() => {
    resetRepairStateStoreForTests();
  });

  test("a terminal stop clears a bound the backstop stranded", async () => {
    // GIVEN a turn marked a repair-retry, but the loop's per-run backstop
    // refused the continue and surfaced the rejection through the terminal
    // stop chain without re-running post-model-call — so the bound is stranded.
    const conversationId = "conv-backstop";
    markOrderingRepairAttempted(conversationId);

    // WHEN the terminal stop hook runs.
    await stop(makeStopCtx({ conversationId }));

    // THEN the stranded bound is cleared so the next turn repairs afresh.
    expect(isOrderingRepairAttempted(conversationId)).toBe(false);
  });

  test("a continuing stop keeps the bound for the in-flight retry", async () => {
    // GIVEN a turn marked a repair-retry, and a stop hook is re-querying the
    // model this turn (decision is continue).
    const conversationId = "conv-continue";
    markOrderingRepairAttempted(conversationId);

    // WHEN the stop hook runs on that continuing stop.
    await stop(makeStopCtx({ conversationId, decision: "continue" }));

    // THEN the bound survives so a later ordering rejection this turn is still
    // recognized as the exhausted second attempt.
    expect(isOrderingRepairAttempted(conversationId)).toBe(true);
  });
});
