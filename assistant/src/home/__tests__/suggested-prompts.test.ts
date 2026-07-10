import { afterEach, describe, expect, mock, test } from "bun:test";

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockIntegrationSummary = "Gmail ✓ | Slack ✓ | Twilio ✗ | Telegram ✗";
let mockSidechainText = "";
let sidechainCalls = 0;

// In-memory stand-in for the memory_checkpoints table so the cache
// round-trips without a real database.
const checkpointStore = new Map<string, string>();
let checkpointWritesShouldThrow = false;

mock.module("../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    if (checkpointWritesShouldThrow) {
      throw new Error("synthetic checkpoint write failure");
    }
    checkpointStore.set(key, value);
  },
  deleteMemoryCheckpoint: (key: string) => {
    checkpointStore.delete(key);
  },
}));

mock.module("../../schedule/integration-status.js", () => ({
  formatIntegrationSummary: async () => mockIntegrationSummary,
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
  runBtwSidechain: async () => {
    sidechainCalls++;
    return { text: mockSidechainText };
  },
}));

mock.module("../../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (e: unknown) => e,
}));

mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: { publish: async () => {} },
}));

const { getSuggestedPrompts, refreshAssistantSuggestedPrompts } =
  await import("../suggested-prompts.js");
const { invalidateAssistantSuggestedPromptsCache } =
  await import("../suggested-prompts-cache.js");

// ─── Tests ─────────────────────────────────────────────────────────────

describe("getSuggestedPrompts", () => {
  afterEach(() => {
    checkpointWritesShouldThrow = false;
    invalidateAssistantSuggestedPromptsCache();
    mockSidechainText = "";
    sidechainCalls = 0;
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

  test("handles empty LLM response gracefully and caches the empty result", async () => {
    mockSidechainText = "";

    expect(await refreshAssistantSuggestedPrompts()).toBe(false);
    expect(await getSuggestedPrompts()).toEqual([]);

    // The empty result is cached: the next refresh within the TTL must
    // not hit the LLM again (prevents a generation loop on every Home
    // feed GET while the model returns nothing usable).
    expect(await refreshAssistantSuggestedPrompts()).toBe(false);
    expect(sidechainCalls).toBe(1);
  });

  test("handles malformed LLM response gracefully", async () => {
    mockSidechainText = "not valid json at all";

    await refreshAssistantSuggestedPrompts();
    const prompts = await getSuggestedPrompts();
    expect(prompts).toEqual([]);
  });

  test("refresh reports whether new content was generated", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Do stuff", prompt: "Do stuff for me" },
    ]);

    expect(await refreshAssistantSuggestedPrompts()).toBe(true);
    // Cache is fresh — second refresh must not hit the LLM again.
    expect(await refreshAssistantSuggestedPrompts()).toBe(false);
    expect(sidechainCalls).toBe(1);
  });

  test("refresh reports false when the cache write fails", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Do stuff", prompt: "Do stuff for me" },
    ]);
    checkpointWritesShouldThrow = true;

    // The generation succeeded but nothing was cached, so the caller must
    // not announce fresh content (clients would refetch into a cache miss
    // and re-trigger generation on every Home load).
    expect(await refreshAssistantSuggestedPrompts()).toBe(false);
    expect(await getSuggestedPrompts()).toEqual([]);
  });

  test("refresh regenerates after invalidation", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Do stuff", prompt: "Do stuff for me" },
    ]);

    await refreshAssistantSuggestedPrompts();
    invalidateAssistantSuggestedPromptsCache();

    expect(await refreshAssistantSuggestedPrompts()).toBe(true);
    expect(sidechainCalls).toBe(2);
  });

  test("cache survives across module state (checkpoint-backed)", async () => {
    mockSidechainText = JSON.stringify([
      { label: "Persisted", prompt: "I came from the checkpoint store" },
    ]);

    await refreshAssistantSuggestedPrompts();
    // Simulate the read path a fresh daemon would take: the prompts come
    // back from the checkpoint store, not module-local memory.
    expect(checkpointStore.get("home:suggested_prompts:json")).toContain(
      "Persisted",
    );
    const prompts = await getSuggestedPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.label).toBe("Persisted");
  });
});
