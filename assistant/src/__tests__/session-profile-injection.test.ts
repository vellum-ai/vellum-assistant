import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/ipc-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

let runCalls: Message[][] = [];
let profileCompilerCalls = 0;
let profileCompilerArgs: Array<Record<string, unknown>> = [];
let recallArgs: Array<Record<string, unknown>> = [];
let profileEnabled = true;
let memoryEnabled = true;
let profileText =
  "<dynamic-user-profile>\n- timezone: America/Los_Angeles\n</dynamic-user-profile>";

const persistedMessages: Array<{
  id: string;
  role: string;
  content: string;
  createdAt: number;
}> = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
  getSocketPath: () => "/tmp/test.sock",
  getDataDir: () => "/tmp",
}));

mock.module("../memory/guardian-action-store.js", () => ({
  getPendingDeliveryByConversation: () => null,
  getGuardianActionRequest: () => null,
  resolveGuardianActionRequest: () => {},
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    maxTokens: 4096,
    thinking: false,
    contextWindow: {
      enabled: true,
      maxInputTokens: 100000,
      targetInputTokens: 80000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 512,
      chunkTokens: 12000,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    apiKeys: {},
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
    memory: {
      enabled: memoryEnabled,
      retrieval: {
        injectionStrategy: "prepend_user_block",
        dynamicBudget: {
          enabled: false,
          minInjectTokens: 1200,
          maxInjectTokens: 10000,
          targetHeadroomTokens: 10000,
        },
      },
      conflicts: {
        enabled: false,
        gateMode: "soft",
        resolverLlmTimeoutMs: 250,
        relevanceThreshold: 0.2,
      },
      profile: {
        enabled: profileEnabled,
        maxInjectTokens: 300,
      },
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
  loadSkillBySelector: () => ({ skill: null }),
  ensureSkillIcon: async () => null,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
}));

mock.module("../skills/slash-commands.js", () => ({
  buildInvocableSlashCatalog: () => new Map(),
  resolveSlashSkillCommand: () => ({ kind: "not_slash" }),
  rewriteKnownSlashCommandPrompt: () => "",
  parseSlashCandidate: () => ({ kind: "not_slash" }),
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => persistedMessages,
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  addMessage: (_conversationId: string, role: string, content: string) => {
    const row = {
      id: `msg-${persistedMessages.length + 1}`,
      role,
      content,
      createdAt: Date.now(),
    };
    persistedMessages.push(row);
    return { id: row.id };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => ({ segmentIds: [], orphanedItemIds: [] }),
  deleteLastExchange: () => 0,
}));

mock.module("../memory/conversation-queries.js", () => ({
  isLastUserMessageToolResult: () => false,
}));

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: "att-1" }),
  linkAttachmentToMessage: () => {},
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async (
    _query: string,
    _convId: string,
    _config: unknown,
    options?: Record<string, unknown>,
  ) => {
    if (options) recallArgs.push(options);
    return {
      enabled: true,
      degraded: false,
      reason: null,
      provider: "mock",
      model: "mock",
      injectedText: "",
      lexicalHits: 0,
      semanticHits: 0,
      recencyHits: 0,
      entityHits: 0,
      relationSeedEntityCount: 0,
      relationTraversedEdgeCount: 0,
      relationNeighborEntityCount: 0,
      relationExpandedItemCount: 0,
      earlyTerminated: false,
      mergedCount: 0,
      selectedCount: 0,
      rerankApplied: false,
      injectedTokens: 0,
      latencyMs: 0,
      topCandidates: [],
    };
  },
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  injectMemoryRecallAsSeparateMessage: (msgs: Message[]) => msgs,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module("../context/window-manager.js", () => ({
  ContextWindowManager: class {
    constructor() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../memory/conflict-store.js", () => ({
  listPendingConflictDetails: () => [],
  applyConflictResolution: () => true,
}));

mock.module("../memory/clarification-resolver.js", () => ({
  resolveConflictClarification: async () => ({
    resolution: "still_unclear",
    strategy: "heuristic",
    resolvedStatement: null,
    explanation: "Need user clarification.",
  }),
}));

mock.module("../memory/admin.js", () => ({
  getMemoryConflictAndCleanupStats: () => ({
    conflicts: { pending: 0, resolved: 0, oldestPendingAgeMs: null },
    cleanup: {
      resolvedBacklog: 0,
      supersededBacklog: 0,
      resolvedCompleted24h: 0,
      supersededCompleted24h: 0,
    },
  }),
}));

mock.module("../memory/profile-compiler.js", () => ({
  compileDynamicProfile: (options?: Record<string, unknown>) => {
    profileCompilerCalls += 1;
    if (options) profileCompilerArgs.push(options);
    return {
      text: profileText,
      sourceCount: 2,
      selectedCount: 1,
      budgetTokens: 300,
      tokenEstimate: 28,
    };
  },
}));

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "usage-1", createdAt: Date.now() }),
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
    ): Promise<Message[]> {
      runCalls.push(messages);
      const assistantMessage: Message = {
        role: "assistant",
        content: [{ type: "text", text: "normal assistant answer" }],
      };
      onEvent({
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        model: "mock",
        providerDurationMs: 10,
      });
      onEvent({ type: "message_complete", message: assistantMessage });
      return [...messages, assistantMessage];
    }
  },
}));
mock.module("../memory/canonical-guardian-store.js", () => ({
  listPendingCanonicalGuardianRequestsByDestinationConversation: () => [],
  listCanonicalGuardianRequests: () => [],
  listPendingRequestsByConversationScope: () => [],
  createCanonicalGuardianRequest: () => ({
    id: "mock-cg-id",
    code: "MOCK",
    status: "pending",
  }),
  getCanonicalGuardianRequest: () => null,
  getCanonicalGuardianRequestByCode: () => null,
  updateCanonicalGuardianRequest: () => {},
  resolveCanonicalGuardianRequest: () => {},
  createCanonicalGuardianDelivery: () => ({ id: "mock-cgd-id" }),
  listCanonicalGuardianDeliveries: () => [],
  listPendingCanonicalGuardianRequestsByDestinationChat: () => [],
  updateCanonicalGuardianDelivery: () => {},
  generateCanonicalRequestCode: () => "MOCK-CODE",
}));

import type { SessionMemoryPolicy } from "../daemon/session.js";
import { DEFAULT_MEMORY_POLICY, Session } from "../daemon/session.js";
import {
  injectDynamicProfileIntoUserMessage,
  stripDynamicProfileMessages,
} from "../daemon/session-dynamic-profile.js";

function makeSession(memoryPolicy?: SessionMemoryPolicy): Session {
  const provider = {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const session = new Session(
    "conv-1",
    provider,
    "system prompt",
    4096,
    () => {},
    "/tmp",
    undefined,
    memoryPolicy,
  );
  session.setTrustContext({ trustClass: "guardian", sourceChannel: "vellum" });
  return session;
}

function messageText(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n");
}

describe("Session dynamic profile injection", () => {
  beforeEach(() => {
    runCalls = [];
    persistedMessages.length = 0;
    profileCompilerCalls = 0;
    profileCompilerArgs = [];
    recallArgs = [];
    profileEnabled = true;
    memoryEnabled = true;
    profileText =
      "<dynamic-user-profile>\n- timezone: America/Los_Angeles\n</dynamic-user-profile>";
  });

  test("injects profile context for runtime and strips it from persisted history", async () => {
    const session = makeSession();
    await session.loadFromDb();

    const events: ServerMessage[] = [];
    await session.processMessage("What should I do next?", [], (event) =>
      events.push(event),
    );

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    expect(runtimeUser.role).toBe("user");
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).toContain("<dynamic-profile-context>");
    expect(runtimeText).toContain("<dynamic-user-profile>");
    expect(runtimeText).toContain("</dynamic-profile-context>");

    const persistedUser = session
      .getMessages()
      .find((message) => message.role === "user");
    expect(persistedUser).toBeDefined();
    if (persistedUser) {
      const persistedText = messageText(persistedUser);
      expect(persistedText).not.toContain("<dynamic-profile-context>");
      expect(persistedText).not.toContain("<dynamic-user-profile>");
      expect(persistedText).not.toContain("</dynamic-profile-context>");
      // No empty text blocks should remain after stripping
      const emptyBlocks = persistedUser.content.filter(
        (b) => b.type === "text" && (b as { text: string }).text === "",
      );
      expect(emptyBlocks).toHaveLength(0);
    }
    expect(profileCompilerCalls).toBe(1);
    expect(events.some((event) => event.type === "message_complete")).toBe(
      true,
    );
  });

  test("strip removes empty text blocks left by dedicated injection block", () => {
    const profile = "timezone: US/Pacific";
    const userMsg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    const injected = injectDynamicProfileIntoUserMessage(userMsg, profile);
    // The injected message has 2 content blocks: original + profile
    expect(injected.content).toHaveLength(2);
    const stripped = stripDynamicProfileMessages([injected], profile);
    // After stripping, the dedicated profile block should be removed entirely
    expect(stripped[0].content).toHaveLength(1);
    expect(
      stripped[0].content.every((b) => {
        return b.type !== "text" || (b as { text: string }).text.length > 0;
      }),
    ).toBe(true);
  });

  test("strip only targets the last user message, not earlier ones", () => {
    const profile = "timezone: US/Pacific";
    const profileMarker = "<dynamic-profile-context>";
    const earlyUser: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `I pasted: ${profileMarker}\ntimezone: US/Pacific\n</dynamic-profile-context>`,
        },
      ],
    };
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    };
    const latestUser: Message = {
      role: "user",
      content: [{ type: "text", text: "follow up" }],
    };
    const injected = injectDynamicProfileIntoUserMessage(latestUser, profile);
    const msgs = [earlyUser, assistant, injected];
    const stripped = stripDynamicProfileMessages(msgs, profile);
    // Earlier user message should be untouched
    expect(messageText(stripped[0])).toContain(profileMarker);
    // Latest user message should have profile removed
    expect(messageText(stripped[2])).not.toContain(profileMarker);
  });

  test("strip finds injected message even when tool_result user messages follow it", () => {
    const profile = "timezone: US/Pacific";
    const profileMarker = "<dynamic-profile-context>";
    const injectedUser = injectDynamicProfileIntoUserMessage(
      { role: "user", content: [{ type: "text", text: "hello" }] },
      profile,
    );
    const assistantMsg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "calling tool" }],
    };
    // Simulate tool_result user message appended by agent loop
    const toolResultUser: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "result" },
      ],
    };
    const msgs = [injectedUser, assistantMsg, toolResultUser];
    const stripped = stripDynamicProfileMessages(msgs, profile);
    // The injected profile should be stripped from the first user message
    expect(messageText(stripped[0])).not.toContain(profileMarker);
    // tool_result message should be untouched
    expect(stripped[2]).toBe(toolResultUser);
  });

  test("skips profile compilation/injection when memory.profile.enabled is false", async () => {
    profileEnabled = false;
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("Explain rebase strategy", [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).not.toContain("<dynamic-profile-context>");
    expect(profileCompilerCalls).toBe(0);
  });

  test("skips profile injection when top-level memory.enabled is false", async () => {
    memoryEnabled = false;
    const session = makeSession();
    await session.loadFromDb();

    await session.processMessage("What is my timezone?", [], () => {});

    expect(runCalls).toHaveLength(1);
    const runtimeUser = runCalls[0][runCalls[0].length - 1];
    const runtimeText = messageText(runtimeUser);
    expect(runtimeText).not.toContain("<dynamic-profile-context>");
    expect(profileCompilerCalls).toBe(0);
  });

  test("private thread session uses private scope + default fallback in profile compile and recall", async () => {
    const privatePolicy: SessionMemoryPolicy = {
      scopeId: "private-thread-abc",
      includeDefaultFallback: true,
      strictSideEffects: false,
    };
    const session = makeSession(privatePolicy);
    await session.loadFromDb();

    await session.processMessage("What do I prefer?", [], () => {});

    // Profile compiler should receive the private scope with fallback enabled
    expect(profileCompilerCalls).toBe(1);
    expect(profileCompilerArgs).toHaveLength(1);
    expect(profileCompilerArgs[0].scopeId).toBe("private-thread-abc");
    expect(profileCompilerArgs[0].includeDefaultFallback).toBe(true);

    // Memory recall should receive scopeId and a scopePolicyOverride for the private scope
    expect(recallArgs).toHaveLength(1);
    expect(recallArgs[0].scopeId).toBe("private-thread-abc");
    expect(recallArgs[0].scopePolicyOverride).toEqual({
      scopeId: "private-thread-abc",
      fallbackToDefault: true,
    });
  });

  test("standard thread uses default scope without fallback in profile compile and no scope override in recall", async () => {
    // Default policy: scopeId='default', includeDefaultFallback=false
    const session = makeSession(DEFAULT_MEMORY_POLICY);
    await session.loadFromDb();

    await session.processMessage("Tell me about TypeScript", [], () => {});

    // Profile compiler should receive default scope without fallback
    expect(profileCompilerCalls).toBe(1);
    expect(profileCompilerArgs).toHaveLength(1);
    expect(profileCompilerArgs[0].scopeId).toBe("default");
    expect(profileCompilerArgs[0].includeDefaultFallback).toBe(false);

    // Memory recall should forward scopeId='default' so buildScopeFilter
    // properly filters to the default scope, and should NOT have a
    // scopePolicyOverride (default scope relies on the global config policy)
    expect(recallArgs).toHaveLength(1);
    expect(recallArgs[0].scopeId).toBe("default");
    expect(recallArgs[0].scopePolicyOverride).toBeUndefined();
  });
});
