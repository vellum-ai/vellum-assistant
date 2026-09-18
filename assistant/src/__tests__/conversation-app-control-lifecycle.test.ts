/**
 * Lifecycle tests for HostAppControlProxy attachment to a Conversation.
 *
 * Verifies that:
 *  - `setHostAppControlProxy` stores the proxy and disposes any prior proxy
 *    when replaced with a different instance.
 *  - `Conversation.dispose()` calls `dispose()` on the attached proxy and
 *    nulls the field so a subsequent `setHostAppControlProxy(newProxy)`
 *    cleanly attaches without double-disposing.
 *
 * Mirrors the dependency mocking pattern used by
 * `conversation-lifecycle.test.ts` so we can construct a real Conversation
 * without bringing up the full daemon stack.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => null,
  createConversation: () => ({ id: "conv-app-control" }),
  addMessage: async () => ({ id: "persisted-1" }),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

// Stub graph_extract / auto-analysis enqueue paths so dispose's best-effort
// background work doesn't reach into real subsystems during the test.
mock.module("../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../runtime/services/auto-analysis-guard.js", () => ({
  isAutoAnalysisConversation: () => false,
}));

import { Conversation } from "../daemon/conversation.js";
import type { HostAppControlProxy } from "../daemon/host-app-control-proxy.js";
import { HostCuProxy } from "../daemon/host-cu-proxy.js";

/**
 * Minimal stand-in for HostAppControlProxy that records dispose() calls.
 * The Conversation only invokes `dispose()` on the proxy in the lifecycle
 * paths under test, so we don't need the rest of the API.
 */
function makeFakeProxy(): {
  proxy: HostAppControlProxy;
  disposeCount: () => number;
} {
  let disposed = 0;
  const fake = {
    dispose() {
      disposed++;
    },
  } as unknown as HostAppControlProxy;
  return { proxy: fake, disposeCount: () => disposed };
}

function makeConversation(): Conversation {
  const provider = {
    name: "mock",
    sendMessage: async () => ({
      content: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
  const conv = new Conversation(
    "conv-app-control",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
}

describe("Conversation HostCuProxy lifecycle", () => {
  test.each(["replace", "remove"] as const)(
    "%s disposes the prior proxy even when mode-session retirement fails",
    async (operation) => {
      const conversation = makeConversation();
      const previous = new HostCuProxy();
      const replacement =
        operation === "replace" ? new HostCuProxy() : undefined;
      conversation.setHostCuProxy(previous);
      const dispose = spyOn(previous, "dispose");
      const endTask = spyOn(
        conversation.computerUseModeSessions,
        "endTask",
      ).mockImplementation(() => {
        throw new Error("session retirement unavailable");
      });
      const pending = previous
        .request(
          "computer_use_click",
          { element_id: 1 },
          conversation.conversationId,
          1,
          "Clicking the button",
        )
        .catch((error: unknown) => error);
      try {
        expect(() => conversation.setHostCuProxy(previous)).not.toThrow();
        expect(endTask).not.toHaveBeenCalled();
        expect(() => conversation.setHostCuProxy(replacement)).not.toThrow();
        expect(await pending).toMatchObject({
          message: "Host CU proxy disposed",
        });
        expect(endTask).toHaveBeenCalledWith({
          turnId: conversation.currentRequestId,
          source: {
            sourceId: previous.sourceId,
            generation: previous.resetGeneration,
          },
        });
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(conversation.hostCuProxy).toBe(replacement);
      } finally {
        endTask.mockRestore();
        dispose.mockRestore();
        previous.dispose();
        replacement?.dispose();
      }
    },
  );
});

describe("Conversation — HostAppControlProxy lifecycle", () => {
  test("setHostAppControlProxy stores the proxy", () => {
    const conversation = makeConversation();
    const { proxy, disposeCount } = makeFakeProxy();

    conversation.setHostAppControlProxy(proxy);

    expect(conversation.hostAppControlProxy).toBe(proxy);
    expect(disposeCount()).toBe(0);
  });

  test("setHostAppControlProxy disposes prior proxy when replaced", () => {
    const conversation = makeConversation();
    const first = makeFakeProxy();
    const second = makeFakeProxy();

    conversation.setHostAppControlProxy(first.proxy);
    conversation.setHostAppControlProxy(second.proxy);

    expect(first.disposeCount()).toBe(1);
    expect(second.disposeCount()).toBe(0);
    expect(conversation.hostAppControlProxy).toBe(second.proxy);
  });

  test("setHostAppControlProxy with the same instance does not redispose", () => {
    const conversation = makeConversation();
    const { proxy, disposeCount } = makeFakeProxy();

    conversation.setHostAppControlProxy(proxy);
    conversation.setHostAppControlProxy(proxy);

    expect(disposeCount()).toBe(0);
    expect(conversation.hostAppControlProxy).toBe(proxy);
  });

  test("setHostAppControlProxy(undefined) disposes the existing proxy", () => {
    const conversation = makeConversation();
    const { proxy, disposeCount } = makeFakeProxy();

    conversation.setHostAppControlProxy(proxy);
    conversation.setHostAppControlProxy(undefined);

    expect(disposeCount()).toBe(1);
    expect(conversation.hostAppControlProxy).toBeUndefined();
  });

  test("Conversation.dispose() disposes the attached proxy and nulls the field", () => {
    const conversation = makeConversation();
    const { proxy, disposeCount } = makeFakeProxy();

    conversation.setHostAppControlProxy(proxy);
    conversation.dispose();

    expect(disposeCount()).toBe(1);
    expect(conversation.hostAppControlProxy).toBeUndefined();
  });

  test("Conversation.dispose() is a no-op when no proxy is attached", () => {
    const conversation = makeConversation();

    expect(() => conversation.dispose()).not.toThrow();
    expect(conversation.hostAppControlProxy).toBeUndefined();
  });

  test("setHostAppControlProxy after dispose cleanly attaches without double-disposing the prior proxy", () => {
    const conversation = makeConversation();
    const first = makeFakeProxy();
    const second = makeFakeProxy();

    conversation.setHostAppControlProxy(first.proxy);
    conversation.dispose();
    // After dispose the field is nulled, so attaching a new proxy must NOT
    // call dispose() on the (already-disposed) prior proxy a second time.
    conversation.setHostAppControlProxy(second.proxy);

    expect(first.disposeCount()).toBe(1);
    expect(second.disposeCount()).toBe(0);
    expect(conversation.hostAppControlProxy).toBe(second.proxy);
  });
});
