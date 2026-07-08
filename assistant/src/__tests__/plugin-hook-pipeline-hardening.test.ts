/**
 * Tests for the hook pipeline's fail-open hardening against misbehaving
 * user-land hooks:
 *
 *  - message-bearing output fields are validated after each hook commit:
 *    unsupported roles (e.g. an OpenAI-style `{ role: "system",
 *    content: "<string>" }`) are dropped, bare-string content is wrapped into
 *    a text block, and unusable replacements are reverted to the pre-hook
 *    value — a malformed message that reached the provider serializers would
 *    otherwise fail every subsequent turn with
 *    `content.map is not a function`;
 *  - external (user-land) hooks are time-boxed so a hung hook cannot block
 *    the agent turn, while first-party default hooks are exempt;
 *  - `resolveMediaReferences` (the providers' shared serialization entry)
 *    normalizes non-array message content instead of letting it reach the
 *    block transforms.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// Module mocks are process-global; the test runner (`scripts/test.ts`) runs
// each test file in its own process, so they cannot leak into other files.

// The pipeline's `broadcast` capability emits through the shared hub; stub it
// so importing the pipeline never touches a live event hub.
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

// Supply hook entries directly instead of going through plugin
// registration/discovery — this lets tests mark entries `external` (user-land)
// to exercise the timeout path, which real registry registration reserves for
// workspace plugins.
let entries: unknown[] = [];
mock.module("../hooks/registry.js", () => ({
  getHookEntriesFor: async () => entries,
}));

import { runHook } from "../plugins/pipeline.js";
import { resolveMediaReferences } from "../providers/media-resolve.js";
import type { Message } from "../providers/types.js";

function userPromptCtx(latestMessages: Message[]) {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    requestId: "req-1",
    prompt: "hello",
    isHiddenPrompt: false,
    originalMessages: Object.freeze([...latestMessages]),
    latestMessages,
    modelProfileKey: "balanced",
    isNonInteractive: false,
  };
}

const validUserMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

afterEach(() => {
  entries = [];
  delete process.env.VELLUM_PLUGIN_HOOK_TIMEOUT_MS;
});

describe("hook output sanitization", () => {
  test("drops an injected message with an unsupported role", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "workspace-plugin" },
        fn: (ctx: { latestMessages: unknown[] }) => {
          ctx.latestMessages.unshift({
            role: "system",
            content: "You MUST run onboarding before anything else.",
          });
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toEqual([validUserMessage]);
  });

  test("wraps bare-string content on a valid role into a text block", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: (ctx: { latestMessages: unknown[] }) => {
          ctx.latestMessages.push({ role: "user", content: "plain string" });
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toEqual([
      validUserMessage,
      { role: "user", content: [{ type: "text", text: "plain string" }] },
    ]);
  });

  test("reverts latestMessages when a hook replaces it with a non-array", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: () => ({ latestMessages: "oops" }),
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toEqual([validUserMessage]);
  });

  test("drops malformed blocks inside a message's content array", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: (ctx: { latestMessages: unknown[] }) => {
          ctx.latestMessages.push({
            role: "assistant",
            content: [{ type: "text", text: "kept" }, "garbage", { no: 1 }],
          });
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "kept" }],
    });
  });

  test("post-model-call: drops a tool_use block missing its required fields", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: (ctx: { content: unknown[] }) => {
          // Missing id/name/input — the loop reads `block.id.length` off every
          // tool_use, so keeping this block would throw before execution.
          ctx.content.push({ type: "tool_use" });
          ctx.content.push({
            type: "tool_use",
            id: "",
            name: "noop",
            input: {},
          });
        },
      },
    ];

    const final = await runHook("post-model-call", {
      conversationId: "conv-1",
      callSite: null,
      content: [{ type: "text", text: "reply" }] as unknown[],
      messages: [validUserMessage],
      stopReason: "tool_use",
      decision: "stop",
    });

    expect(final.content).toEqual([
      { type: "text", text: "reply" },
      { type: "tool_use", id: "", name: "noop", input: {} },
    ]);
  });

  test("post-model-call: wraps a string content replacement into a text block", async () => {
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: () => ({ content: "rewritten reply" }),
      },
    ];

    const final = await runHook("post-model-call", {
      conversationId: "conv-1",
      callSite: null,
      content: [{ type: "text", text: "original" }],
      messages: [validUserMessage],
      stopReason: "end_turn",
      decision: "stop",
    });

    expect(final.content).toEqual([{ type: "text", text: "rewritten reply" }]);
  });

  test("post-tool-use: reverts a toolResponse replaced with a non-tool_result", async () => {
    const toolResponse = {
      type: "tool_result",
      tool_use_id: "tu-1",
      content: "ok",
    };
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: () => ({ toolResponse: "not a block" }),
      },
    ];

    const final = await runHook("post-tool-use", {
      conversationId: "conv-1",
      toolResponse,
      messages: [validUserMessage],
      additionalContext: null,
      model: "m",
      callSite: null,
      supportsDynamicUi: true,
      maxInputTokens: 100_000,
    });

    expect(final.toolResponse).toEqual(toolResponse);
  });

  test("valid hook output passes through untouched", async () => {
    const injected: Message = {
      role: "user",
      content: [{ type: "text", text: "context" }],
    };
    entries = [
      {
        owner: { kind: "plugin", id: "p" },
        fn: (ctx: { latestMessages: Message[] }) => {
          ctx.latestMessages.unshift(injected);
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toEqual([injected, validUserMessage]);
  });
});

describe("external hook execution timeout", () => {
  test("a hung external hook is abandoned and the chain continues", async () => {
    process.env.VELLUM_PLUGIN_HOOK_TIMEOUT_MS = "50";
    entries = [
      {
        owner: { kind: "workspace", id: "hung-hook" },
        external: true,
        fn: () => new Promise(() => {}),
      },
      {
        owner: { kind: "plugin", id: "next-hook" },
        fn: (ctx: { latestMessages: Message[] }) => {
          ctx.latestMessages.push({
            role: "user",
            content: [{ type: "text", text: "after timeout" }],
          });
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toEqual([
      validUserMessage,
      { role: "user", content: [{ type: "text", text: "after timeout" }] },
    ]);
  });

  test("default (non-external) hooks are not time-boxed", async () => {
    process.env.VELLUM_PLUGIN_HOOK_TIMEOUT_MS = "10";
    entries = [
      {
        owner: { kind: "plugin", id: "slow-default" },
        fn: async (ctx: { latestMessages: Message[] }) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          ctx.latestMessages.push({
            role: "user",
            content: [{ type: "text", text: "slow but kept" }],
          });
        },
      },
    ];

    const final = await runHook(
      "user-prompt-submit",
      userPromptCtx([validUserMessage]),
    );

    expect(final.latestMessages).toHaveLength(2);
  });
});

describe("provider serializer belt", () => {
  test("resolveMediaReferences wraps non-array content into a text block", () => {
    const poisoned = [
      { role: "assistant", content: "bare string" } as unknown as Message,
      validUserMessage,
    ];

    const resolved = resolveMediaReferences(poisoned);

    expect(resolved[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "bare string" }],
    });
    expect(resolved[1]).toBe(validUserMessage);
  });
});
