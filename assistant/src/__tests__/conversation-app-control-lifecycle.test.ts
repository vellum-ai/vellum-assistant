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

import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: false, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 100000,
          targetBudgetRatio: 0.3,
          compactThreshold: 0.8,
          summaryBudgetRatio: 0.05,
          overflowRecovery: {
            enabled: true,
            safetyMarginRatio: 0.05,
            maxAttempts: 3,
            interactiveLatestTurnCompression: "summarize",
            nonInteractiveLatestTurnCompression: "truncate",
          },
        },
      },
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
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

mock.module("../memory/conversation-crud.js", () => ({
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
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

// Stub graph_extract / auto-analysis enqueue paths so dispose's best-effort
// background work doesn't reach into real subsystems during the test.
mock.module("../memory/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../memory/auto-analysis-enqueue.js", () => ({
  enqueueAutoAnalysisIfEnabled: () => {},
}));

mock.module("../memory/auto-analysis-guard.js", () => ({
  isAutoAnalysisConversation: () => false,
}));

import { Conversation } from "../daemon/conversation.js";
import type { HostAppControlProxy } from "../daemon/host-app-control-proxy.js";

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
    4096,
    () => {},
    "/tmp",
  );
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
}

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
