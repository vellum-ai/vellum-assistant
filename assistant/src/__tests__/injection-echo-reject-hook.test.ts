/**
 * Tests for the default `injection-echo-reject` plugin's hooks.
 *
 * Covers:
 * - Rejecting a main-agent completion that opens with a reserved envelope,
 *   dropping tool calls, and appending a user-role rejection notice.
 * - Leaving mid-message XML, quoted tags, non-mainAgent calls, and provider
 *   errors untouched.
 * - The one-shot retry bound and the `stop` hook that clears it.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { INTERNAL_NUDGE_OUTPUT_SUPPRESSION } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  PostModelCallContext,
  StopContext,
} from "../plugin-api/types.js";
import {
  buildInjectionEchoNudgeText,
} from "../plugins/defaults/injection-echo-reject/hooks/post-model-call.js";
import postModelCall from "../plugins/defaults/injection-echo-reject/hooks/post-model-call.js";
import stop from "../plugins/defaults/injection-echo-reject/hooks/stop.js";
import {
  isInjectionEchoRejected,
  markInjectionEchoRejected,
  resetInjectionEchoRejectStoreForTests,
} from "../plugins/defaults/injection-echo-reject/reject-state-store.js";
import type { ContentBlock, Message } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function userPrompt(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-echo",
    callSite: "mainAgent",
    content: [],
    messages: [userPrompt("continue")],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-stop",
    messages: [],
    exitReason: "no_tool_calls",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetInjectionEchoRejectStoreForTests();
});

describe("injection-echo-reject nudge text", () => {
  test("wraps the shared suppression clause and names the reserved tag", () => {
    const nudge = buildInjectionEchoNudgeText("turn_context");
    expect(nudge).toContain(INTERNAL_NUDGE_OUTPUT_SUPPRESSION);
    expect(nudge.startsWith("<system_notice>")).toBe(true);
    expect(nudge.endsWith("</system_notice>")).toBe(true);
    expect(nudge).toContain("<turn_context>");
    expect(nudge).toContain("Reply to the user normally");
  });
});

describe("injection-echo-reject post-model-call hook", () => {
  test("rejects a reserved opener, drops tools, and continues with a nudge", async () => {
    const leaked: ContentBlock[] = [
      {
        type: "text",
        text: "<turn_context>\ncurrent_time: noon\n</turn_context>\nAlice here.",
      },
      {
        type: "tool_use",
        id: "tu_1",
        name: "file_read",
        input: { path: "threads.md" },
      },
    ];
    const ctx = makeCtx({ content: leaked });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
    expect(ctx.content).toEqual([]);
    expect(ctx.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: buildInjectionEchoNudgeText("turn_context") },
      ],
    });
  });

  test("leaves mid-message XML untouched", async () => {
    const content: ContentBlock[] = [
      {
        type: "text",
        text: "An example <turn_context> block is injected each turn.",
      },
    ];
    const ctx = makeCtx({ content });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual(content);
    expect(ctx.messages).toHaveLength(1);
  });

  test("leaves a non-mainAgent call untouched", async () => {
    const content: ContentBlock[] = [
      { type: "text", text: "<memory>\nleaked\n</memory>" },
    ];
    const ctx = makeCtx({
      callSite: "memoryRetrospective",
      content,
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toEqual(content);
  });

  test("ignores a provider rejection", async () => {
    const ctx = makeCtx({
      content: [{ type: "text", text: "<turn_context>\nleaked" }],
      error: new Error("provider rejected the request"),
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(ctx.content).toHaveLength(1);
  });

  test("a second reserved opener this run is stripped but not nudged again", async () => {
    const first = makeCtx({
      conversationId: "conv-bound",
      content: [{ type: "text", text: "<system_notice>leaked" }],
    });
    await postModelCall(first);
    expect(first.decision).toBe("continue");

    const second = makeCtx({
      conversationId: "conv-bound",
      content: [
        { type: "text", text: "<turn_context>\nagain" },
        { type: "tool_use", id: "tu_2", name: "file_read", input: {} },
      ],
    });
    await postModelCall(second);

    expect(second.decision).toBe("stop");
    expect(second.content).toEqual([]);
    expect(second.messages).toHaveLength(1);
  });
});

describe("injection-echo-reject stop hook", () => {
  test("a terminal stop clears the reject bound", async () => {
    const conversationId = "conv-stop-clear";
    markInjectionEchoRejected(conversationId);

    await stop(makeStopCtx({ conversationId }));

    expect(isInjectionEchoRejected(conversationId)).toBe(false);
  });
});
