/**
 * The `empty-response` plugin's tool-gated branch. The plugin owns no flag
 * read of its own: the loop declares `assistantTextSuppressed` on the
 * post-model-call context, and the plugin acts on that. A main-agent turn that
 * ends without a `send_user_message` call this response cycle is nudged once,
 * and the second such turn lets the turn end so the loop can surface the raw
 * text as the fallback.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type {
  PluginLogger,
  PostModelCallContext,
} from "../plugin-api/types.js";
import postModelCall, {
  SEND_USER_MESSAGE_NUDGE_TEXT,
} from "../plugins/defaults/empty-response/hooks/post-model-call.js";
import { resetEmptyResponseNudgeStoreForTests } from "../plugins/defaults/empty-response/nudge-state-store.js";
import type { Message } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-sum",
    callSite: "mainAgent",
    content: [{ type: "text", text: "Two meetings today." }],
    messages: [],
    stopReason: null,
    assistantTextSuppressed: true,
    decision: "stop",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

/** A prior assistant turn this cycle that reached the user through the tool. */
const priorSendTurn: Message = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "send_user_message",
      input: { message: "Checking now." },
    },
  ],
};

beforeEach(() => {
  resetEmptyResponseNudgeStoreForTests();
});

describe("empty-response hook under the tool-gated reply surface", () => {
  test("nudges once for a turn that never called the tool", async () => {
    const ctx = makeCtx();
    await postModelCall(ctx);
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages.at(-1)?.content).toEqual([
      { type: "text", text: SEND_USER_MESSAGE_NUDGE_TEXT },
    ]);
  });

  test("lets the second such turn end so the loop can fall back", async () => {
    const first = makeCtx();
    await postModelCall(first);
    expect(first.decision).toBe("continue");

    const second = makeCtx();
    await postModelCall(second);
    expect(second.decision).toBe("stop");
    expect(second.messages).toEqual([]);
  });

  test("stays quiet when the tool already carried a message this cycle", async () => {
    const ctx = makeCtx({ messages: [priorSendTurn] });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([priorSendTurn]);
  });

  test("stays quiet for a call site that keeps streamed text", async () => {
    const ctx = makeCtx({ callSite: "callAgent" });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([]);
  });

  test("does nothing on a run whose text is not suppressed", async () => {
    const ctx = makeCtx({ assistantTextSuppressed: false });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([]);
  });
});
