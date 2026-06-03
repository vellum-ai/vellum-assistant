/**
 * Tests for the default `title-generate` plugin's `user-prompt-submit` hook.
 *
 * Title generation fires once per submitted prompt as a fire-and-forget side
 * effect. The hook is a pure trigger — it schedules the work on a later
 * macrotask (so the main agent-loop LLM request is issued first) and lets the
 * title service resolve the provider, persist the title, and broadcast the
 * resulting `conversation_title_updated` / `sync_changed` events. The hook
 * passes only the conversation id and the submitted prompt text.
 *
 * Mocks `memory/conversation-title-service.js` so the tests don't touch the
 * real provider stack, and resets the plugin registry between cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the title-generation service before importing anything that binds
// to it, so both the default plugin and the hook capture the stubbed binding.
const queueGenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    userMessage?: string;
  }): void => undefined,
);
mock.module("../memory/conversation-title-service.js", () => ({
  queueGenerateConversationTitle: queueGenerateConversationTitleMock,
}));

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import userPromptSubmit from "../plugins/defaults/title-generate/hooks/user-prompt-submit.js";
import { defaultTitleGeneratePlugin } from "../plugins/defaults/title-generate/register.js";
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
    prompt: "first message",
    originalMessages: messages,
    latestMessages: messages,
    logger: noopLogger,
    ...overrides,
  };
}

/** Flush pending `setTimeout(0)` callbacks so the fire-and-forget trigger runs. */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
