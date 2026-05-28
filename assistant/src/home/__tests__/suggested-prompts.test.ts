import { afterEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockIntegrationSummary = "Gmail ✓ | Slack ✓ | Twilio ✗ | Telegram ✗";
let mockSidechainText = "";

mock.module("../../schedule/integration-status.js", () => ({
  formatIntegrationSummary: async () => mockIntegrationSummary,
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ llm: {} }),
}));

mock.module("../../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({ provider: "mock", maxTokens: 256 }),
}));

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({}),
}));

mock.module("../../prompts/persona-resolver.js", () => ({
  resolvePersonaContext: () => ({
    userPersona: null,
    userSlug: null,
    channelPersona: null,
  }),
}));

mock.module("../../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "mock system prompt",
}));

mock.module("../../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: async () => ({ text: mockSidechainText }),
}));

mock.module("../../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (e: unknown) => e,
}));

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: { publish: async () => {} },
}));

const {
  getSuggestedPrompts,
  refreshAssistantSuggestedPrompts,
  invalidateAssistantSuggestedPromptsCache,
} = await import("../suggested-prompts.js");

// ─── Tests ─────────────────────────────────────────────────────────────

describe("getSuggestedPrompts", () => {
  afterEach(() => {
    invalidateAssistantSuggestedPromptsCache();
    mockSidechainText = "";
  });

  test("returns empty array before cache is populated", async () => {
    const prompts = await getSuggestedPrompts();
    expect(prompts).toEqual([]);
  });

  test("returns LLM-generated prompts after refresh", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Triage my inbox", prompt: "Help me triage my inbox" },
      { label: "Check meetings", prompt: "What meetings do I have today?" },
    ]);

    await refreshAssistantSuggestedPrompts();
    const prompts = await getSuggestedPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.label).toBe("Triage my inbox");
    expect(prompts[0]!.source).toBe("assistant");
    expect(prompts[1]!.label).toBe("Check meetings");
  });

  test("invalidation clears the cache", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Do stuff", prompt: "Do stuff for me" },
    ]);

    await refreshAssistantSuggestedPrompts();
    expect(await getSuggestedPrompts()).toHaveLength(1);

    invalidateAssistantSuggestedPromptsCache();
    expect(await getSuggestedPrompts()).toEqual([]);
  });

  test("handles empty LLM response gracefully", async () => {
    mockSidechainText = "";

    await refreshAssistantSuggestedPrompts();
    const prompts = await getSuggestedPrompts();
    expect(prompts).toEqual([]);
  });

  test("handles malformed LLM response gracefully", async () => {
    mockSidechainText = "not valid json at all";

    await refreshAssistantSuggestedPrompts();
    const prompts = await getSuggestedPrompts();
    expect(prompts).toEqual([]);
  });
});
