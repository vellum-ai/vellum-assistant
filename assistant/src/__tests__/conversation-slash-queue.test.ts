import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Conversation import so Bun applies them at load time.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../memory/guardian-action-store.js", () => ({
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

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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
}));

mock.module("../memory/conversation-queries.js", () => ({
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
  onEvent: (event: AgentEvent) => void;
}

let pendingRuns: PendingRun[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
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
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (
        checkpoint: CheckpointInfo,
      ) => CheckpointDecision | Promise<CheckpointDecision>,
    ): Promise<Message[]> {
      return new Promise<Message[]>((resolve) => {
        pendingRuns.push({ resolve, messages, onEvent });
      });
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

mock.module("../memory/app-git-service.js", () => ({
  commitAppTurnChanges: async () => {},
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

// ---------------------------------------------------------------------------
// Import Conversation AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

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
    4096,
    () => {},
    "/tmp",
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

function resolveRun(index: number) {
  const run = pendingRuns[index];
  if (!run) throw new Error(`No pending run at index ${index}`);
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: `reply-${index}` }],
  };
  run.onEvent({
    type: "usage",
    inputTokens: 10,
    outputTokens: 5,
    model: "mock",
    providerDurationMs: 100,
  });
  run.onEvent({ type: "message_complete", message: assistantMsg });
  run.resolve([...run.messages, assistantMsg]);
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
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a slash-like passthrough and a normal passthrough after it.
    // Both resolve to passthrough, so the batch builder groups them into one run.
    conversation.enqueueMessage(
      "/not-a-skill",
      [],
      (e) => eventsSlash.push(e),
      "req-slash",
    );
    conversation.enqueueMessage("msg-3", [], (e) => events3.push(e), "req-3");
    expect(conversation.getQueueDepth()).toBe(2);

    // Complete first run — drain pulls both queued messages into one batched run.
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    // Both batched clients see their own message_dequeued.
    expect(eventsSlash.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(events3.some((e) => e.type === "message_dequeued")).toBe(true);

    // Exactly 2 runs total: msg-1 + batched [/not-a-skill, msg-3].
    expect(pendingRuns.length).toBe(2);

    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("queued skill-name slash passes through as-is", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const events1: ServerMessage[] = [];
    const eventsSlash: ServerMessage[] = [];

    // Start first message — blocks on agent loop
    const p1 = conversation.processMessage(
      "msg-1",
      [],
      (e) => events1.push(e),
      "req-1",
    );
    await waitForPendingRun(1);

    // Enqueue a slash command that matches a skill name — still passes through
    conversation.enqueueMessage(
      "/start-the-day",
      [],
      (e) => eventsSlash.push(e),
      "req-slash",
    );

    // Complete first run — triggers drain
    resolveRun(0);
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

    resolveRun(1);
    await new Promise((r) => setTimeout(r, 50));
  });

  test("passthrough batch is terminated by a /compact in the middle of the queue", async () => {
    const conversation = makeConversation();
    await conversation.loadFromDb();

    const eventsHi: ServerMessage[] = [];
    const eventsCompact: ServerMessage[] = [];
    const eventsBye: ServerMessage[] = [];

    // Start in-flight message
    const p1 = conversation.processMessage("msg-1", [], () => {}, "req-1");
    await waitForPendingRun(1);

    // Enqueue ["hi", "/compact", "bye"]. /compact is non-passthrough, so the
    // batch builder stops at "hi" (length-1 batch → drainSingleMessage). Then
    // /compact takes its short-circuit path (no new runAgentLoop), and "bye"
    // drains as its own run.
    conversation.enqueueMessage("hi", [], (e) => eventsHi.push(e), "req-hi");
    conversation.enqueueMessage(
      "/compact",
      [],
      (e) => eventsCompact.push(e),
      "req-compact",
    );
    conversation.enqueueMessage("bye", [], (e) => eventsBye.push(e), "req-bye");
    expect(conversation.getQueueDepth()).toBe(3);

    // Resolve msg-1 → drain pulls only "hi" (batch builder stops at /compact).
    resolveRun(0);
    await p1;
    await waitForPendingRun(2);

    expect(pendingRuns.length).toBe(2);
    expect(eventsHi.some((e) => e.type === "message_dequeued")).toBe(true);

    // Resolve "hi" → /compact short-circuits without a new runAgentLoop, then
    // drains "bye" as its own run.
    resolveRun(1);
    await waitForPendingRun(3);

    expect(eventsCompact.some((e) => e.type === "message_complete")).toBe(true);
    expect(eventsBye.some((e) => e.type === "message_dequeued")).toBe(true);
    expect(pendingRuns.length).toBe(3);

    resolveRun(2);
    await new Promise((r) => setTimeout(r, 50));
  });
});
