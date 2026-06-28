import { beforeEach, describe, expect, test } from "bun:test";

import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";
import { HOOKS } from "./constants.js";
import type { PluginLogger, TurnCommitContext } from "./types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(
  overrides: Partial<TurnCommitContext> = {},
): TurnCommitContext {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  return {
    conversationId: "conv-1",
    userMessageId: "msg-user-1",
    messages,
    turnCount: 1,
    isNonInteractive: false,
    logger: noopLogger,
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginRegistryForTests();
});

describe("turn-commit hook", () => {
  test("fires once per committed turn with the right context", async () => {
    const seen: TurnCommitContext[] = [];
    registerPlugin({
      manifest: { name: "test-turn-commit-consumer", version: "1.0.0" },
      hooks: {
        [HOOKS.TURN_COMMIT]: async (ctx: TurnCommitContext) => {
          seen.push(ctx);
        },
      },
    });

    const ctx = makeCtx({ turnCount: 7, userMessageId: "msg-user-7" });
    await runHook(HOOKS.TURN_COMMIT, ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.conversationId).toBe("conv-1");
    expect(seen[0]!.userMessageId).toBe("msg-user-7");
    expect(seen[0]!.turnCount).toBe(7);
    expect(seen[0]!.isNonInteractive).toBe(false);
    expect(seen[0]!.messages).toHaveLength(2);
  });

  test("a throwing hook is contained — runHook resolves and the turn still commits", async () => {
    const observed: string[] = [];
    registerPlugin({
      manifest: { name: "test-turn-commit-thrower", version: "1.0.0" },
      hooks: {
        [HOOKS.TURN_COMMIT]: async () => {
          throw new Error("consolidation enqueue blew up");
        },
      },
    });
    registerPlugin({
      manifest: { name: "test-turn-commit-after", version: "1.0.0" },
      hooks: {
        [HOOKS.TURN_COMMIT]: async () => {
          observed.push("after");
        },
      },
    });

    // The hook runner contains the throw: the chain continues and resolves.
    await expect(runHook(HOOKS.TURN_COMMIT, makeCtx())).resolves.toBeDefined();
    // A later hook still ran, mirroring the loop's fire-and-forget guarantee
    // that a failing consolidation hook cannot fail the committed turn.
    expect(observed).toEqual(["after"]);
  });

  test("with no registered consumer the hook is a no-op (additive)", async () => {
    const ctx = makeCtx();
    const result = await runHook(HOOKS.TURN_COMMIT, ctx);
    // Same reference back when no plugin registers the hook.
    expect(result).toBe(ctx);
  });
});
