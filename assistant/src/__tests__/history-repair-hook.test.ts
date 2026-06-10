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
 * `stop` (error-stop recovery):
 * - On an error stop carrying a repairable ordering rejection, the hook
 *   deep-repairs the messages and asks the loop to continue.
 * - Bounded to one pass per turn via the per-conversation repair state: a
 *   second consecutive ordering rejection is left to surface; the bound clears
 *   at the turn boundary.
 * - Ignores non-ordering errors and successful (non-error) stops.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  StopContext,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import stop from "../plugins/defaults/history-repair/hooks/stop.js";
import userPromptSubmit from "../plugins/defaults/history-repair/hooks/user-prompt-submit.js";
import {
  getRepairState,
  resetRepairState,
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

// ─── Stop hook (error-stop recovery) ─────────────────────────────────────────

/** An ordering-violating history: a leading assistant turn deep-repair strips. */
function orderingViolatingHistory(): Message[] {
  return [
    { role: "assistant", content: [{ type: "text", text: "orphaned" }] },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ];
}

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

  test("repairable ordering error → deep-repairs and continues", async () => {
    // GIVEN an error stop carrying a repairable ordering rejection over a
    // history with a leading assistant turn.
    const messages = orderingViolatingHistory();
    const expected = deepRepairHistory(messages).messages;
    const ctx = makeStopCtx({
      messages,
      error: new Error(ORDERING_ERROR_MESSAGE),
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it rewrites the messages to the deep-repaired history and asks the
    // loop to retry.
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages).toEqual(expected);
    expect(getRepairState(ctx.conversationId).orderingRepairAttempted).toBe(
      true,
    );
  });

  test("second consecutive ordering rejection is left to surface", async () => {
    // GIVEN a turn whose first ordering rejection already triggered a repair.
    const conversationId = "conv-bounded";
    getRepairState(conversationId).orderingRepairAttempted = true;
    const messages = orderingViolatingHistory();
    const ctx = makeStopCtx({
      conversationId,
      messages,
      error: new Error(ORDERING_ERROR_MESSAGE),
    });

    // WHEN a second ordering rejection reaches the hook.
    await stop(ctx);

    // THEN it does not repair again — the bound holds and the error surfaces.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });

  test("repairs again after the turn boundary resets the bound", async () => {
    // GIVEN a conversation that already attempted a repair this turn.
    const conversationId = "conv-reset";
    getRepairState(conversationId).orderingRepairAttempted = true;

    // AND the turn boundary clears the per-conversation bound.
    resetRepairState(conversationId);

    // WHEN a later turn hits a repairable ordering rejection.
    const ctx = makeStopCtx({
      conversationId,
      messages: orderingViolatingHistory(),
      error: new Error(ORDERING_ERROR_MESSAGE),
    });
    await stop(ctx);

    // THEN the hook repairs independently of the prior turn.
    expect(ctx.decision).toBe("continue");
  });

  test("non-ordering error is left untouched", async () => {
    // GIVEN an error stop whose rejection is not an ordering violation.
    const messages = orderingViolatingHistory();
    const ctx = makeStopCtx({
      messages,
      error: new Error("rate limit exceeded"),
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it defers — the decision and history are unchanged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });

  test("successful (non-error) stop is ignored", async () => {
    // GIVEN a successful stop — the model returned a response, no error.
    const messages = orderingViolatingHistory();
    const ctx = makeStopCtx({
      messages,
      responseContent: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it does nothing — repair only applies to ordering rejections.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });
});
