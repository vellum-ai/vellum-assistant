/**
 * Tests for the default `compaction` plugin's `conversation-dispose` hook.
 *
 * The compaction module owns the per-conversation `ContextWindowManager` store,
 * so conversation teardown must release a conversation's manager by firing the
 * `conversation-dispose` hook rather than reaching into the store directly.
 *
 * Covers:
 * - The default compaction plugin contributes a `conversation-dispose` hook.
 * - Running the hook chain (via the registry) drops the disposed
 *   conversation's manager from the store, keyed on `conversationId`.
 *
 * The store's `disposeContextWindowManager` is stubbed so the assertion targets
 * the wiring (plugin → hook → store release) without depending on the store's
 * internal representation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const disposeContextWindowManager = mock((_conversationId: string) => {});

mock.module("../plugins/defaults/compaction/manager-store.js", () => ({
  disposeContextWindowManager,
}));

import { HOOKS } from "../plugin-api/constants.js";
import type { ConversationDisposeContext } from "../plugin-api/types.js";
import { defaultCompactionPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

describe("compaction conversation-dispose hook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    disposeContextWindowManager.mockClear();
  });

  test("the default compaction plugin contributes a conversation-dispose hook", () => {
    // GIVEN the default compaction plugin definition.
    // WHEN its hook map is inspected.
    const hook = defaultCompactionPlugin.hooks?.["conversation-dispose"];

    // THEN the conversation-dispose hook is present.
    expect(hook).toBeDefined();
  });

  test("running the hook chain releases the conversation's manager from the store", async () => {
    // GIVEN the default compaction plugin is registered.
    registerPlugin(defaultCompactionPlugin);

    // WHEN the conversation-dispose chain runs for a conversation.
    await runHook<ConversationDisposeContext>(HOOKS.CONVERSATION_DISPOSE, {
      conversationId: "conv-123",
    });

    // THEN the store is told to release that conversation's manager.
    expect(disposeContextWindowManager).toHaveBeenCalledTimes(1);
    expect(disposeContextWindowManager).toHaveBeenCalledWith("conv-123");
  });
});
