/**
 * Tests for the default `title-generate` plugin's hooks.
 *
 * The plugin contributes two pure-trigger hooks that delegate the title work
 * to the service:
 *
 * - `user-prompt-submit` — first-pass generation from the submitted prompt,
 *   scheduled on a later macrotask so the main agent-loop LLM request is
 *   issued first.
 * - `stop` — fallback retry for replaceable titles and second-pass
 *   regeneration once the conversation reaches its third user turn.
 *
 * Both let the title service resolve the provider, persist the title, and
 * broadcast the resulting `conversation_title_updated` / `sync_changed`
 * events.
 *
 * Mocks `persistence/conversation-title-service.js` and `config/loader.js` so the
 * tests don't touch the real provider stack or config, and resets the plugin
 * registry between cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the title-generation service before importing anything that binds
// to it, so both the default plugin and the hooks capture the stubbed binding.
const queueGenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    userMessage?: string;
  }): void => undefined,
);
const queueRegenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    onlyIfReplaceable?: boolean;
  }): void => undefined,
);
mock.module("../persistence/conversation-title-service.js", () => ({
  AUTO_TITLE_DETERMINISTIC: 2,
  isReplaceableTitle: (title: string | null) =>
    title == null ||
    title === "" ||
    title === "Generating title..." ||
    title === "New Conversation" ||
    title === "Untitled" ||
    title === "Untitled Conversation" ||
    title.startsWith("Runtime: "),
  queueGenerateConversationTitle: queueGenerateConversationTitleMock,
  queueRegenerateConversationTitle: queueRegenerateConversationTitleMock,
}));

const mockGetConversation = mock(
  (_conversationId: string) =>
    ({
      title: "Existing Title",
      isAutoTitle: 1,
      conversationType: "standard",
    }) as {
      title: string;
      isAutoTitle: number;
      conversationType: string;
    },
);
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: mockGetConversation,
}));

// The `stop` hook reads `conversations.skipAutoRetitling`; stub the loader so
// the opt-out is controllable per test.
let skipAutoRetitling = false;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ conversations: { skipAutoRetitling } }),
}));

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  StopContext,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import { defaultTitleGeneratePlugin } from "../plugins/defaults/index.js";
import stop from "../plugins/defaults/title-generate/hooks/stop.js";
import userPromptSubmit from "../plugins/defaults/title-generate/hooks/user-prompt-submit.js";
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

function makeCtx(
  overrides: Partial<UserPromptSubmitContext> = {},
): UserPromptSubmitContext {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "first message" }] },
  ];
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    requestId: "req-1",
    modelProfileKey: "balanced",
    isNonInteractive: false,
    prompt: "first message",
    originalMessages: messages,
    latestMessages: messages,
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

/** Flush pending `setTimeout(0)` callbacks so the fire-and-forget trigger runs. */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function userTurn(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantTurn(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** A user-role message carrying only tool results, not a fresh prompt. */
function toolResultTurn(): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
  };
}

/** History with `count` genuine user turns interleaved with assistant replies. */
function historyWithUserTurns(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push(userTurn(`message ${i}`));
    messages.push(assistantTurn(`reply ${i}`));
  }
  return messages;
}

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-1",
    messages: historyWithUserTurns(3),
    exitReason: "no_tool_calls",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

describe("title-generate user-prompt-submit hook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    queueGenerateConversationTitleMock.mockReset();
    queueGenerateConversationTitleMock.mockImplementation(() => undefined);
  });

  test("queues a title-generation job from the submitted prompt", async () => {
    // GIVEN a fresh user prompt submission
    const ctx = makeCtx({ conversationId: "conv-1", prompt: "first message" });

    // WHEN the default hook runs and its deferred work flushes
    await userPromptSubmit(ctx);
    await flushMacrotasks();

    // THEN the title service is invoked with just the conversation id and the
    // submitted prompt — provider resolution and emit are owned by the service.
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueGenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call?.userMessage).toBe("first message");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("onTitleUpdated");
  });

  test("skips title generation for hidden machine-signal prompts", async () => {
    // A hidden send (e.g. the channel-setup wizard-close marker) is not user
    // speech — minting a title from it would surface invisible scaffolding
    // text in the sidebar.
    const ctx = makeCtx({
      prompt:
        "[User action on channel_setup surface: closed the slack setup wizard]",
      isHiddenPrompt: true,
    });

    await userPromptSubmit(ctx);
    await flushMacrotasks();

    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("does not block: returns before the title job is scheduled", async () => {
    // GIVEN a fresh user prompt submission
    const ctx = makeCtx();

    // WHEN the hook resolves
    await userPromptSubmit(ctx);

    // THEN the title job has not run yet (it is deferred to a later macrotask),
    // AND it runs once the macrotask queue is flushed.
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(0);
    await flushMacrotasks();
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("fires through runHook once the default plugin is registered", async () => {
    // GIVEN the default title-generate plugin registered in the registry
    registerPlugin(defaultTitleGeneratePlugin);

    // WHEN a prompt is submitted through the hook chain
    await runHook(
      HOOKS.USER_PROMPT_SUBMIT,
      makeCtx({ prompt: "draft a plan" }),
    );
    await flushMacrotasks();

    // THEN the title service is triggered with the submitted prompt text
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(
      queueGenerateConversationTitleMock.mock.calls[0]?.[0]?.userMessage,
    ).toBe("draft a plan");
  });
});

describe("title-generate stop hook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    queueRegenerateConversationTitleMock.mockReset();
    queueRegenerateConversationTitleMock.mockImplementation(() => undefined);
    mockGetConversation.mockReset();
    mockGetConversation.mockImplementation(
      (_conversationId: string) =>
        ({
          title: "Existing Title",
          isAutoTitle: 1,
          conversationType: "standard",
        }) as {
          title: string;
          isAutoTitle: number;
          conversationType: string;
        },
    );
    skipAutoRetitling = false;
  });

  test("regenerates the title on the third user turn", async () => {
    // GIVEN a turn ending with three genuine user prompts in history
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the stop hook runs and its deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN the second-pass regeneration is triggered with just the
    // conversation id — provider resolution and emit are owned by the service.
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueRegenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("signal");
    expect(call).not.toHaveProperty("onlyIfReplaceable");
  });

  test("retries a replaceable fallback title after a successful turn", async () => {
    mockGetConversation.mockReturnValueOnce({
      title: "Untitled Conversation",
      isAutoTitle: 2,
      conversationType: "standard",
    });
    const ctx = makeStopCtx({ messages: historyWithUserTurns(1) });

    await stop(ctx);
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      onlyIfReplaceable: true,
    });
  });

  test("preserves the third-turn retitle when the title is still replaceable", async () => {
    mockGetConversation.mockReturnValueOnce({
      title: "Untitled Conversation",
      isAutoTitle: 2,
      conversationType: "standard",
    });
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    await stop(ctx);
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueRegenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call).not.toHaveProperty("onlyIfReplaceable");
  });

  test("fallback title retry is not blocked by the retitling opt-out", async () => {
    skipAutoRetitling = true;
    mockGetConversation.mockReturnValueOnce({
      title: "Generating title...",
      isAutoTitle: 1,
      conversationType: "standard",
    });
    const ctx = makeStopCtx({ messages: historyWithUserTurns(1) });

    await stop(ctx);
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      onlyIfReplaceable: true,
    });
  });

  test("defers the regeneration so the completed turn is persisted first", async () => {
    // GIVEN a turn ending on the third user turn
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the hook resolves
    await stop(ctx);

    // THEN the regeneration has not fired yet — it is deferred to a later
    // macrotask so the turn's assistant reply lands first, AND it fires once
    // the macrotask queue is flushed.
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
    await flushMacrotasks();
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("does not regenerate before the third user turn", async () => {
    // GIVEN a turn ending with only two genuine user prompts
    const ctx = makeStopCtx({ messages: historyWithUserTurns(2) });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — the conversation lacks enough context yet
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("does not regenerate after the third user turn", async () => {
    // GIVEN a turn ending with four genuine user prompts
    const ctx = makeStopCtx({ messages: historyWithUserTurns(4) });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — the single second pass already passed
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("ignores tool-result user messages when counting turns", async () => {
    // GIVEN three genuine user prompts plus a tool-result user message
    const messages: Message[] = [
      userTurn("message 1"),
      assistantTurn("reply 1"),
      userTurn("message 2"),
      assistantTurn("calling a tool"),
      toolResultTurn(),
      assistantTurn("reply 2"),
      userTurn("message 3"),
    ];
    const ctx = makeStopCtx({ messages });

    // WHEN the stop hook runs and its deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN the tool-result message is not counted as a turn, so the third
    // genuine prompt still triggers the regeneration
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("does not regenerate on a non-success terminal exit", async () => {
    // GIVEN a third-user-turn stop that ended on a provider error rather than
    // a finalized no-tool reply
    const ctx = makeStopCtx({
      messages: historyWithUserTurns(3),
      exitReason: "error",
      error: new Error("provider rejected"),
    });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — there is no new topic to re-title from
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("respects the skipAutoRetitling opt-out", async () => {
    // GIVEN the user opted out of second-pass retitling
    skipAutoRetitling = true;
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the stop hook runs on the third user turn and any work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("fires through runHook once the default plugin is registered", async () => {
    // GIVEN the default title-generate plugin registered in the registry
    registerPlugin(defaultTitleGeneratePlugin);

    // WHEN a third-user-turn stop is dispatched through the hook chain
    await runHook(
      HOOKS.STOP,
      makeStopCtx({ messages: historyWithUserTurns(3) }),
    );
    await flushMacrotasks();

    // THEN the second-pass regeneration is triggered
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(
      queueRegenerateConversationTitleMock.mock.calls[0]?.[0]?.conversationId,
    ).toBe("conv-1");
  });
});
