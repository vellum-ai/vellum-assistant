import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent, AgentLoopRunResult } from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  conversationMessagesSyncTag,
  type SyncChangedEvent,
} from "../daemon/message-types/sync.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Conversation import so Bun applies them at load time.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

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
    memory: {
      v2: { enabled: false },
      retrieval: { scratchpadInjection: { enabled: true } },
    },
    conversations: { skipAutoRetitling: false },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: "conv-1" }),
  addMessage: (_convId: string, _role: string, _content: string) => {
    return { id: `msg-${Date.now()}` };
  },
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  getMessageById: () => null,
  getLastUserTimestampBefore: () => 0,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  updateMessageContent: mock(() => {}),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",

    semanticHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
    constructor() {}
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
    resetOverflowRecovery() {}
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

// Mock skill catalog — "start-the-day" is available
mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [
    {
      id: "start-the-day",
      name: "Start the Day",
      displayName: "Start the Day",
      description: "Morning routine skill",
      directoryPath: "/skills/start-the-day",
      skillFilePath: "/skills/start-the-day/SKILL.md",

      source: "managed",
    },
  ],
  loadSkillBySelector: () => null,
  ensureSkillIcon: () => {},
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: (catalog: Record<string, unknown>[]) =>
    catalog.map((s) => ({
      summary: s,
      state: "enabled",
    })),
}));

// ---------------------------------------------------------------------------
// Controllable AgentLoop mock.
// ---------------------------------------------------------------------------

interface PendingRun {
  resolve: (history: Message[]) => void;
  messages: Message[];
  onEvent: (event: AgentEvent) => void | Promise<void>;
}

let pendingRuns: PendingRun[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    getActiveModel() {
      return undefined;
    }
    async run(options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void | Promise<void>;
    }): Promise<AgentLoopRunResult> {
      const { messages, onEvent } = options;
      const history = await new Promise<Message[]>((resolve) => {
        pendingRuns.push({ resolve, messages, onEvent });
      });
      return {
        history,
        exitReason: null,
        newMessages: history.slice(messages.length),
      };
    }
  },
}));
// Avoid real workspace-git initialization on /tmp — on CI runners,
// `git add -A` under /tmp hits permission errors on systemd-private dirs,
// which blocks `runAgentLoopImpl` for long enough to trip the test's
// `waitForPendingRun` 2s timeout before `AgentLoop.run` is invoked.
mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
  }),
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../contacts/canonical-guardian-store.js", () => ({
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

// ---------------------------------------------------------------------------
// Import Conversation AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { waitFor } from "./helpers/wait-for.js";

type ConversationWithWorkspaceDeps = Conversation & {
  getWorkspaceGitService?: (_workspaceDir: string) => {
    ensureInitialized: () => Promise<void>;
  };
};

function makeConversation(): Conversation {
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
  const conversation = new Conversation(
    "conv-1",
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  // Bypass real workspace git init: with "/tmp" as the workspace dir, a real
  // ensureInitialized() walks all of /tmp and can exceed the 2s waitForPendingRun
  // budget on CI where parallel tests churn /tmp subdirectories.
  (conversation as ConversationWithWorkspaceDeps).getWorkspaceGitService =
    () => ({
      ensureInitialized: async () => {},
    });
  return conversation;
}

async function waitForPendingRun(
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (pendingRuns.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${count} pending runs (have ${pendingRuns.length})`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: `reply-${index}` }],
  };
  // Prime the assistant row anchor — production code emits this from
  // `AgentLoop.run` just before `provider.sendMessage`.
  await run.onEvent({ type: "llm_call_started" });
  await run.onEvent({
    type: "usage",
    inputTokens: 10,
    outputTokens: 5,
    model: "mock",
    providerDurationMs: 100,
  });
  await run.onEvent({ type: "message_complete", message: assistantMsg });
  run.resolve([...run.messages, assistantMsg]);
}

function syncChangedMessages(): {
  messages: SyncChangedEvent[];
  dispose: () => void;
} {
  const messages: SyncChangedEvent[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      if (event.message.type === "sync_changed") {
        messages.push(event.message);
      }
    },
  });
  return {
    messages,
    dispose: () => subscription.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation queue — slash-like messages pass through to agent loop", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("queued slash-like input does not stall queue — batches with siblings", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];
    const events3: ServerMessage[] = [];

    // Start first message — blocks on agent loop
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a slash-like passthrough and a normal passthrough after it.
    // Both resolve to passthrough, so the batch builder groups them into one run.
    conversation.enqueueMessage({
      content: "/not-a-skill",
      onEvent: (e) => eventsSlash.push(e),
      requestId: "req-slash",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: (e) => events3.push(e),
      requestId: "req-3",
    });
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete first run — drain pulls both queued messages into one batched run.
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Both batched clients see their own message_dequeued.
    expect(eventsSlash.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(events3.some((e) => e.type === "message_dequeued")).toBe(true);

    // Exactly 2 runs total: msg-1 + batched [/not-a-skill, msg-3].
    expect(pendingRuns.length).toBe(2);

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("batched queued messages with the same event sink do not duplicate assistant stream events", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const sharedEvents: ServerMessage[] = [];
    const sharedOnEvent = (event: ServerMessage) => sharedEvents.push(event);

    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    conversation.enqueueMessage({
      content: "msg-2",
      onEvent: sharedOnEvent,
      requestId: "req-2",
    });
    conversation.enqueueMessage({
      content: "msg-3",
      onEvent: sharedOnEvent,
      requestId: "req-3",
    });

    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(
      sharedEvents.filter((event) => event.type === "message_dequeued"),
    ).toHaveLength(2);

    sharedEvents.length = 0;
    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      sharedEvents.filter((event) => event.type === "message_complete"),
    ).toHaveLength(1);
  });

  test("queued skill-name slash passes through as-is", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];

    // Start first message — blocks on agent loop
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      onEvent: (e) => events1.push(e),
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue a slash command that matches a skill name — still passes through
    conversation.enqueueMessage({
      content: "/start-the-day",
      onEvent: (e) => eventsSlash.push(e),
      requestId: "req-slash",
    });

    // Complete first run — triggers drain
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // The slash message goes through the agent loop unchanged
    const lastUserMsg =
      pendingRuns[1].messages[pendingRuns[1].messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const text = lastUserMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    // Content passes through as-is — no rewriting
    expect(text).toContain("/start-the-day");

    await resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("passthrough batch is terminated by a /compact in the middle of the queue", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsHi: ServerMessage[] = [];
    const eventsCompact: ServerMessage[] = [];
    const eventsBye: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage({
      content: "msg-1",
      attachments: [],
      requestId: "req-1",
    });
    await waitForPendingRun(1);

    // Enqueue ["hi", "/compact", "bye"]. /compact is non-passthrough, so the
    // batch builder stops at "hi" (length-1 batch → drainSingleMessage). Then
    // /compact takes its short-circuit path (no new runAgentLoop), and "bye"
    // drains as its own run.
    conversation.enqueueMessage({
      content: "hi",
      onEvent: (e) => eventsHi.push(e),
      requestId: "req-hi",
    });
    conversation.enqueueMessage({
      content: "/compact",
      onEvent: (e) => eventsCompact.push(e),
      requestId: "req-compact",
    });
    conversation.enqueueMessage({
      content: "bye",
      onEvent: (e) => eventsBye.push(e),
      requestId: "req-bye",
    });
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls only "hi" (batch builder stops at /compact).
    await resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(pendingRuns.length).toBe(2);
    expect(eventsHi.some((e) => e.type === "message_dequeued")).toBe(true);

    // Resolve "hi" → /compact short-circuits without a new runAgentLoop, then
    // drains "bye" as its own run.
    await resolveRun(1);
    await waitForPendingRun(3);

    expect(eventsCompact.some((e) => e.type === "message_complete")).toBe(true);
    expect(eventsBye.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(pendingRuns.length).toBe(3);

    await resolveRun(2);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("/compact failure still emits message-history sync after persisting the user message", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();
    conversation.forceCompact = async () => {
      throw new Error("compaction failed");
    };

    const sync = syncChangedMessages();
    try {
      await expect(
        conversation.processMessage({
          content: "/compact",
          attachments: [],
          requestId: "req-compact",
        }),
      ).rejects.toThrow("compaction failed");

      await waitFor(
        () =>
          sync.messages.some(
            (message) =>
              message.tags.length === 1 &&
              message.tags[0] === conversationMessagesSyncTag("conv-1"),
          ),
        {
          message:
            "Timed out waiting for /compact failure message-history sync tag",
        },
      );
    } finally {
      sync.dispose();
    }
  });
});
