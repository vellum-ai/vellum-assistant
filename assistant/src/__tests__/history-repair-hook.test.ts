/**
 * Tests for the default `history-repair` plugin's `user-prompt-submit` hook.
 *
 * Covers:
 * - The hook normalizes `latestMessages` exactly as `repairHistory` would for
 *   the three documented repair classes (orphan tool_result, missing
 *   tool_result, consecutive same-role messages) and is a no-op for a
 *   well-formed history.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire and repair the working message list.
 * - Chain ordering: because defaults register first, the default repair hook
 *   runs ahead of a later-registered user hook, which therefore observes an
 *   already-normalized history.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import userPromptSubmit from "../plugins/defaults/history-repair/hooks/user-prompt-submit.js";
import { repairHistory } from "../plugins/defaults/history-repair/terminal.js";
import { defaultHistoryRepairPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";

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
