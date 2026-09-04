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

/** A prior assistant turn whose only tool call reported the outcome. */
const priorSendTurn: Message = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "send_user_message",
      input: { message: "You have two meetings today." },
    },
  ],
};

/**
 * A progress update sent alongside the work it announces: the user knows the
 * assistant started, not what it found.
 */
const progressUpdateThenWorkTurn: Message = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "send_user_message",
      input: { message: "Checking your calendar." },
    },
    { type: "tool_use", id: "tu_2", name: "bash", input: { command: "cal" } },
  ],
};

/** Work with no message at all. */
const workOnlyTurn: Message = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "tu_3", name: "bash", input: { command: "cal" } },
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

  test("stays quiet when the last tool-bearing response reported the outcome", async () => {
    const ctx = makeCtx({ messages: [workOnlyTurn, priorSendTurn] });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual([workOnlyTurn, priorSendTurn]);
  });

  test("nudges when a progress update was followed by work the user never heard about", async () => {
    // send_user_message("Checking your calendar.") + bash in one response, then
    // a terminal text-only response: the result never reached the user.
    const ctx = makeCtx({ messages: [progressUpdateThenWorkTurn] });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("continue");
    expect(ctx.messages.at(-1)?.content).toEqual([
      { type: "text", text: SEND_USER_MESSAGE_NUDGE_TEXT },
    ]);
  });

  test("nudges when the last tool-bearing response was work with no message", async () => {
    const ctx = makeCtx({ messages: [priorSendTurn, workOnlyTurn] });
    await postModelCall(ctx);
    expect(ctx.decision).toBe("continue");
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
