import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
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

// Mutable store so each test can configure its own messages
let mockDbMessages: Array<{
  id: string;
  role: string;
  content: string;
  metadata?: string | null;
}> = [];
let mockConversation: Record<string, unknown> | null = null;
let nextMockMessageId = 1;

mock.module("../persistence/conversation-crud.js", () => ({
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
  getMessages: () => mockDbMessages,
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-1" }),
  addMessage: async (
    _conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    const metadata = options?.metadata;
    const id = `persisted-${nextMockMessageId++}`;
    mockDbMessages.push({
      id,
      role,
      content,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
    return { id };
  },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

// `loadFromDb` reads the conversation's pruned v3 card slugs (prune valve)
// when a row carries a `memoryV3InjectedBlock`. Stub the store read so these
// tests never touch a real DB; the stub DELEGATES to the real implementation
// unless this file is actively running (`mock.module` is process-global and
// would otherwise leak into sibling files that use the real store).
const realEverInjectedStore = {
  ...(await import("../plugins/defaults/memory/v3/ever-injected-store.js")),
};
let lifecycleStoreMockActive = false;
let mockPrunedSlugs = new Set<string>();
mock.module("../plugins/defaults/memory/v3/ever-injected-store.js", () => ({
  ...realEverInjectedStore,
  getPrunedSlugs: (conversationId: string) =>
    lifecycleStoreMockActive
      ? mockPrunedSlugs
      : realEverInjectedStore.getPrunedSlugs(conversationId),
}));

import {
  Conversation,
  type ConversationConstructorOptions,
} from "../daemon/conversation.js";

beforeEach(() => {
  lifecycleStoreMockActive = true;
  mockPrunedSlugs = new Set();
});

afterAll(() => {
  lifecycleStoreMockActive = false;
});

function makeConversation(
  options: ConversationConstructorOptions = { maxTokens: 4096 },
): Conversation {
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
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    options,
  );
  // Default to guardian trust so tests load all messages.
  conv.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return conv;
}

function defaultConv() {
  return {
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  };
}

describe("Conversation — subagent identity", () => {
  test("is not a subagent by default", () => {
    const conv = makeConversation();
    expect(conv.parentConversationId).toBeUndefined();
    expect(conv.isSubagent).toBe(false);
  });

  test("derives isSubagent from the constructor parentConversationId", () => {
    const conv = makeConversation({
      maxTokens: 4096,
      parentConversationId: "parent-1",
    });
    expect(conv.parentConversationId).toBe("parent-1");
    expect(conv.isSubagent).toBe(true);
  });
});

describe("loadFromDb metadata injection rehydration", () => {
  beforeEach(() => {
    nextMockMessageId = 1;
  });

  test("memory-only rehydration still works (regression guard)", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
        metadata: JSON.stringify({ memoryInjectedBlock: "remember: alice" }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
      // Ensure m1 is historical (not the tail) so memory rehydration triggers
      // on a non-tail user row. Memory applies to all rows either way, but a
      // trailing assistant message keeps things concrete.
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<memory>\nremember: alice\n</memory>",
      },
      { type: "text", text: "Hi" },
    ]);
  });

  test("historical user row rehydrates all three injection fields", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          turnContextBlock: "<turn_context>\nctx payload\n</turn_context>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb payload\n</system_reminder>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Second turn (tail)" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // m1 is historical (not tail) — all three blocks should rehydrate in the
    // documented shape: [<turn_context>, <memory>, <system_reminder>, ...original]
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<turn_context>\nctx payload\n</turn_context>",
      },
      {
        type: "text",
        text: "<memory>\nmem payload\n</memory>",
      },
      {
        type: "text",
        text: "<system_reminder>\npkb payload\n</system_reminder>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("tail user row skips turn_context and system_reminder", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          turnContextBlock: "<turn_context>\nctx\n</turn_context>",
          pkbSystemReminderBlock: "<system_reminder>\npkb\n</system_reminder>",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // Tail row: memory still rehydrates (existing behavior), but turn_context
    // and system_reminder are skipped — the next turn's applyRuntimeInjections
    // will supply fresh blocks for the tail.
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toEqual([
      {
        type: "text",
        text: "<memory>\nmem payload\n</memory>",
      },
      { type: "text", text: "Tail turn" },
    ]);
  });

  test("missing fields are no-op: empty metadata leaves content unchanged", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({}),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Second" }]),
        metadata: JSON.stringify({ userMessageChannel: "desktop" }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
    expect(messages[2].content).toEqual([{ type: "text", text: "Second" }]);
  });

  test("historical wrapped memoryInjectedBlock rehydrates singly-wrapped", async () => {
    // Historical v2 rows persisted `injectedBlockText` already wrapped in
    // `<memory>...</memory>`. After unifying v2's storage with v1's
    // unwrapped contract, the rehydrate path must defensively strip any
    // pre-existing wrapper so old rows don't render double-wrapped.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "<memory>\nremember: alice\n</memory>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    const firstBlock = messages[0].content[0];
    expect(firstBlock).toEqual({
      type: "text",
      text: "<memory>\nremember: alice\n</memory>",
    });
    if (firstBlock.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);
  });

  test("memoryV3InjectedBlock rehydrates wrapped on ALL rows (tail included)", async () => {
    // The memory-v3 frozen card block persists UNWRAPPED under its own key and
    // must come back wrapped on every row — including the tail, since the next
    // turn injects only NET-NEW cards (deduped via the v3 store) and never
    // re-renders this row's cards.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
        metadata: JSON.stringify({
          memoryV3InjectedBlock: "# memory/concepts/page-b.md\nhead b",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<memory>\nheader line\n\n# memory/concepts/page-a.md\nhead a\n</memory>",
      },
      { type: "text", text: "First turn" },
    ]);
    // Tail row rehydrates too (unlike turn_context / system_reminder).
    expect(messages[2].content).toEqual([
      {
        type: "text",
        text: "<memory>\n# memory/concepts/page-b.md\nhead b\n</memory>",
      },
      { type: "text", text: "Tail turn" },
    ]);
  });

  test("pruned slugs' card sections are skipped at v3 rehydration (prune valve persistence)", async () => {
    // The prune valve marks cards pruned in the everInjected store instead of
    // rewriting the persisted metadata; the rehydration splice re-filters on
    // every load, which is what makes a prune survive restarts.
    mockConversation = defaultConv();
    mockPrunedSlugs = new Set(["page-a"]);
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a\n\n# memory/concepts/page-b.md\nhead b",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<memory>\nheader line\n\n# memory/concepts/page-b.md\nhead b\n</memory>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("a fully-pruned memoryV3InjectedBlock is skipped entirely at rehydration", async () => {
    mockConversation = defaultConv();
    mockPrunedSlugs = new Set(["page-a"]);
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    // No memory block at all — an instruction header with zero cards carries
    // no content (matches the live strip, which removes the emptied block).
    expect(messages[0].content).toEqual([{ type: "text", text: "First turn" }]);
  });

  test("defensively-wrapped memoryV3InjectedBlock rehydrates singly-wrapped", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hi" }]),
        metadata: JSON.stringify({
          memoryV3InjectedBlock:
            "<memory>\n# memory/concepts/page-a.md\nhead a\n</memory>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    const firstBlock = messages[0].content[0];
    expect(firstBlock).toEqual({
      type: "text",
      text: "<memory>\n# memory/concepts/page-a.md\nhead a\n</memory>",
    });
    if (firstBlock.type !== "text") throw new Error("unexpected block type");
    expect(firstBlock.text.match(/<memory>/g)?.length).toBe(1);
  });

  test("malformed metadata is tolerated: load does not throw, content unchanged", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: "not-json",
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
    ];

    const conversation = makeConversation();
    // Should not throw
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
  });

  test("historical user row rehydrates memoryV2StaticBlock between memory and system_reminder", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb payload\n</system_reminder>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toEqual([
      { type: "text", text: "<memory>\nmem payload\n</memory>" },
      {
        type: "text",
        text: "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
      },
      {
        type: "text",
        text: "<system_reminder>\npkb payload\n</system_reminder>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("legacy <memory>-wrapped memoryV2StaticBlock rehydrates verbatim", async () => {
    // `meta.memoryV2StaticBlock` may carry either `<info>…</info>` or
    // legacy `<memory>…</memory>` wrappers depending on when the row was
    // persisted. The rehydrate path replays the stored text verbatim,
    // so both wrappers must round-trip unchanged.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryV2StaticBlock:
            "<memory>\n## Essentials\n\nAlice prefers VS Code.\n</memory>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail turn" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<memory>\n## Essentials\n\nAlice prefers VS Code.\n</memory>",
      },
      { type: "text", text: "First turn" },
    ]);
  });

  test("tail user row skips memoryV2StaticBlock", async () => {
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({
          memoryV2StaticBlock: "<info>\n## Essentials\n\nleak\n</info>",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[2].role).toBe("user");
    // Tail row receives fresh injection on the next turn — the persisted
    // static block must not rehydrate here.
    expect(messages[2].content).toEqual([{ type: "text", text: "Tail" }]);
  });

  test("internal-channel trusted_contact view still rehydrates memoryV2StaticBlock", async () => {
    // Rehydration keys on `sourceChannel`, not `trustClass`: injection uses
    // `shouldExposePersonalMemory`, which exposes personal memory whenever
    // `sourceChannel === "vellum"` regardless of actor trust class. So a
    // trusted_contact view arriving over the internal `"vellum"` channel
    // rehydrates `memoryV2StaticBlock`. The rehydrate gate must match
    // injection so a daemon-restart reload of the same conversation produces
    // an identical prefix.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({
          // Rows must carry `trusted_contact` / `unknown` provenance to
          // survive the row-level filter for non-guardian views.
          provenanceTrustClass: "trusted_contact",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "vellum",
    });
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
      },
      { type: "text", text: "First" },
    ]);
  });

  test("rehydration order matches injection-time order for the full personal-memory set", async () => {
    // Injection-time layout (per `applyRuntimeInjections` after-memory-
    // prefix splicing in ascending injector order: pkb-context 30,
    // pkb-reminder 35, memory-v2-static 38, now-md 40):
    //   [<memory>dynamic</memory>, <info>v2static</info>, <NOW.md>,
    //    <system_reminder>, <knowledge_base>, ...original]
    // Rehydration must reproduce this exactly so Anthropic's prefix cache
    // matches msg[0] across daemon restarts.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          memoryInjectedBlock: "mem payload",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
          nowScratchpadBlock: "<NOW.md>\nnow body\n</NOW.md>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb reminder body\n</system_reminder>",
          pkbContextBlock: "<knowledge_base>\nkb body\n</knowledge_base>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      { type: "text", text: "<memory>\nmem payload\n</memory>" },
      {
        type: "text",
        text: "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
      },
      { type: "text", text: "<NOW.md>\nnow body\n</NOW.md>" },
      {
        type: "text",
        text: "<system_reminder>\npkb reminder body\n</system_reminder>",
      },
      { type: "text", text: "<knowledge_base>\nkb body\n</knowledge_base>" },
      { type: "text", text: "First turn" },
    ]);
  });

  test("rehydration order matches live assembly when memoryV2StaticBlock and memoryV3InjectedBlock co-occur", async () => {
    // First-turn and first-post-compaction rows of a memory-v3-live
    // conversation persist BOTH `memoryV2StaticBlock` and the v3 card block.
    // Live assembly applies after-memory-prefix splices in ascending
    // injector order (pkb-context 30, pkb-reminder 35, memory-v2-static 38,
    // now-md 40, memory-v3-shadow 1000); each splice lands at the
    // memory-prefix boundary (`countMemoryPrefixBlocks` counts `<memory>`
    // AND `<info>` blocks), so the v3 block — spliced last and itself
    // `<memory>`-wrapped — lands AFTER the `<info>` static block but before
    // now-md's earlier splice:
    //   [<workspace>, <turn_context>, <memory>dynamic</memory>,
    //    <info>v2static</info>, <memory>v3cards</memory>, <NOW.md>,
    //    <system_reminder>, <knowledge_base>, ...original]
    // Rehydration must reproduce this byte-for-byte or every daemon restart
    // busts the provider prefix cache for the whole conversation history.
    // (`memoryInjectedBlock` and the v3 key are mutually exclusive on real
    // rows; both are included here to pin the relative order of all splices.)
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          workspaceBlock: "<workspace>\nworkspace body\n</workspace>",
          turnContextBlock: "<turn_context>\nctx payload\n</turn_context>",
          memoryInjectedBlock: "mem payload",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a",
          nowScratchpadBlock: "<NOW.md>\nnow body\n</NOW.md>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb reminder body\n</system_reminder>",
          pkbContextBlock: "<knowledge_base>\nkb body\n</knowledge_base>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      { type: "text", text: "<workspace>\nworkspace body\n</workspace>" },
      { type: "text", text: "<turn_context>\nctx payload\n</turn_context>" },
      { type: "text", text: "<memory>\nmem payload\n</memory>" },
      {
        type: "text",
        text: "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
      },
      {
        type: "text",
        text: "<memory>\nheader line\n\n# memory/concepts/page-a.md\nhead a\n</memory>",
      },
      { type: "text", text: "<NOW.md>\nnow body\n</NOW.md>" },
      {
        type: "text",
        text: "<system_reminder>\npkb reminder body\n</system_reminder>",
      },
      { type: "text", text: "<knowledge_base>\nkb body\n</knowledge_base>" },
      { type: "text", text: "First turn" },
    ]);
  });

  test("rehydration order matches live assembly for background-turn / channel-capabilities / non-interactive-context", async () => {
    // A background/scheduled source's live turns inject three extra blocks that
    // the metadata persist layer now captures so a reloaded or forked
    // conversation (memory retrospective) reproduces them byte-for-byte.
    // Live assembly lands them at:
    //   - `<background_turn>` — prepend-user-tail injector order 15, between
    //     `<workspace>` (10) and `<turn_context>` (20).
    //   - `<channel_capabilities>` — Step-3 prepend, just below `<turn_context>`
    //     and above the after-memory region.
    //   - `<non_interactive_context>` — Step-3 APPEND, the very last block.
    // Expected layout (cf. live `applyRuntimeInjections`):
    //   [<workspace>, <background_turn>, <turn_context>, <channel_capabilities>,
    //    <memory>dynamic</memory>, <info>v2static</info>, <memory>v3</memory>,
    //    <NOW.md>, <system_reminder>, <knowledge_base>, ...original,
    //    <non_interactive_context>]
    // Rehydration must reproduce this or a background-source fork busts the
    // message-tier prefix cache at the first divergent block.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First turn" }]),
        metadata: JSON.stringify({
          workspaceBlock: "<workspace>\nworkspace body\n</workspace>",
          backgroundTurnBlock: "<background_turn>\nbg body\n</background_turn>",
          turnContextBlock: "<turn_context>\nctx payload\n</turn_context>",
          channelCapabilitiesBlock:
            "<channel_capabilities>\nchannel: vellum\n</channel_capabilities>",
          memoryInjectedBlock: "mem payload",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a",
          nowScratchpadBlock: "<NOW.md>\nnow body\n</NOW.md>",
          pkbSystemReminderBlock:
            "<system_reminder>\npkb reminder body\n</system_reminder>",
          pkbContextBlock: "<knowledge_base>\nkb body\n</knowledge_base>",
          nonInteractiveContextBlock:
            "<non_interactive_context>\nno human present\n</non_interactive_context>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      { type: "text", text: "<workspace>\nworkspace body\n</workspace>" },
      { type: "text", text: "<background_turn>\nbg body\n</background_turn>" },
      { type: "text", text: "<turn_context>\nctx payload\n</turn_context>" },
      {
        type: "text",
        text: "<channel_capabilities>\nchannel: vellum\n</channel_capabilities>",
      },
      { type: "text", text: "<memory>\nmem payload\n</memory>" },
      {
        type: "text",
        text: "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
      },
      {
        type: "text",
        text: "<memory>\nheader line\n\n# memory/concepts/page-a.md\nhead a\n</memory>",
      },
      { type: "text", text: "<NOW.md>\nnow body\n</NOW.md>" },
      {
        type: "text",
        text: "<system_reminder>\npkb reminder body\n</system_reminder>",
      },
      { type: "text", text: "<knowledge_base>\nkb body\n</knowledge_base>" },
      { type: "text", text: "First turn" },
      {
        type: "text",
        text: "<non_interactive_context>\nno human present\n</non_interactive_context>",
      },
    ]);
  });

  test("tail user row skips background-turn / channel-capabilities / non-interactive-context", async () => {
    // The tail row re-injects these fresh next turn, so rehydration must skip
    // them on the tail — mirroring `<turn_context>` / `<workspace>`.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({
          backgroundTurnBlock: "<background_turn>\nbg body\n</background_turn>",
          channelCapabilitiesBlock:
            "<channel_capabilities>\nchannel: vellum\n</channel_capabilities>",
          nonInteractiveContextBlock:
            "<non_interactive_context>\nno human present\n</non_interactive_context>",
        }),
      },
    ];

    const conversation = makeConversation();
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([{ type: "text", text: "Tail" }]);
  });

  test("untrusted-actor view does not rehydrate memoryV2StaticBlock", async () => {
    mockConversation = defaultConv();
    // Rows with `trusted_contact` / `unknown` provenance survive the
    // untrusted-actor row filter, so this isolates the rehydrate gate.
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nprivate memory\n</info>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "unknown" }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "telegram",
    });
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // The historical row survives row-level filtering but the rehydrate gate
    // suppresses the personal-memory block.
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
  });

  test("untrusted-actor view does not rehydrate memoryV3InjectedBlock (including the tail)", async () => {
    mockConversation = defaultConv();
    // v3 cards carry personal memory and rehydrate on ALL rows including the
    // tail (see the positive test above), so the trust gate must suppress both
    // the historical and the tail block. `trusted_contact` provenance keeps the
    // rows past the untrusted-actor row filter, isolating the rehydrate gate.
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          memoryV3InjectedBlock:
            "header line\n\n# memory/concepts/page-a.md\nhead a",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "unknown" }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          memoryV3InjectedBlock: "# memory/concepts/page-b.md\nhead b",
        }),
      },
    ];

    const conversation = makeConversation();
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "telegram",
    });
    await conversation.loadFromDb();
    const messages = conversation.getMessages();

    expect(messages).toHaveLength(3);
    // Neither the historical nor the tail v3 card block is prepended.
    expect(messages[0].content).toEqual([{ type: "text", text: "First" }]);
    expect(messages[2].content).toEqual([{ type: "text", text: "Tail" }]);
  });

  test("ensureActorScopedHistory reloads when sourceChannel changes within the same trust class", async () => {
    // Regression: cache invalidation previously keyed only on trust class.
    // `loadFromDb` gates `memoryV2StaticBlock` rehydration on `sourceChannel`
    // via `shouldExposePersonalMemory`, so a same-trust-class reuse from a
    // different channel (e.g. internal `vellum` → remote channel) must
    // re-run `loadFromDb` or stale personal-memory exposure persists.
    mockConversation = defaultConv();
    mockDbMessages = [
      {
        id: "m1",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "First" }]),
        metadata: JSON.stringify({
          provenanceTrustClass: "trusted_contact",
          memoryV2StaticBlock:
            "<info>\n## Essentials\n\nprivate memory\n</info>",
        }),
      },
      {
        id: "m2",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Reply" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
      {
        id: "m3",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Tail" }]),
        metadata: JSON.stringify({ provenanceTrustClass: "trusted_contact" }),
      },
    ];

    const conversation = makeConversation();
    // First load: internal channel, trusted_contact actor → personal memory
    // exposed via `shouldExposePersonalMemory({sourceChannel: "vellum", ...})`.
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "vellum",
    });
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()[0].content).toEqual([
      {
        type: "text",
        text: "<info>\n## Essentials\n\nprivate memory\n</info>",
      },
      { type: "text", text: "First" },
    ]);

    // Reuse with the same trust class but a remote channel. The cache must
    // invalidate and trigger a reload that strips the personal-memory block.
    conversation.setTrustContext({
      trustClass: "trusted_contact",
      sourceChannel: "telegram",
    });
    await conversation.ensureActorScopedHistory();
    expect(conversation.getMessages()[0].content).toEqual([
      { type: "text", text: "First" },
    ]);
  });
});
