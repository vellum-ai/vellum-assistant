import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede the Session import so Bun applies them at load time.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../util/platform.js", () => ({
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
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      preserveRecentMessages: 6,
      summaryModel: "mock-model",
      maxSummaryTokens: 512,
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
    memory: { retrieval: { injectionStrategy: "inline" } },
    daemon: {
      startupSocketWaitMs: 5000,
      stopTimeoutMs: 5000,
      sigkillGracePeriodMs: 2000,
      titleGenerationMaxTokens: 30,
      standaloneRecording: true,
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
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
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
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallIntoUserMessage: (msg: Message) => msg,
  stripMemoryRecallMessages: (msgs: Message[]) => msgs,
}));

mock.module("../memory/admin.js", () => ({
  getMemoryCleanupStats: () => ({
    cleanup: {
      supersededBacklog: 0,
      supersededCompleted24h: 0,
    },
  }),
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

// Mock skill catalog to provide a known slash skill
mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [
    {
      id: "start-the-day",
      name: "Start the Day",
      displayName: "Start the Day",
      description: "Morning routine skill",
      directoryPath: "/skills/start-the-day",
      skillFilePath: "/skills/start-the-day/SKILL.md",
      userInvocable: true,
      disableModelInvocation: false,
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
      degraded: false,
    })),
}));

// ---------------------------------------------------------------------------
// Controllable AgentLoop mock that captures the content passed to run().
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
    async run(
      messages: Message[],
      onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      return new Promise<Message[]>((resolve) => {
        pendingRuns.push({ resolve, messages, onEvent });
      });
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

// ---------------------------------------------------------------------------
// Import Session AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Session } from "../daemon/session.js";

function makeSession(): Session {
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
  return new Session(
    "conv-1",
    provider,
    "system prompt",
    4096,
    () => {},
    "/tmp",
  );
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
// Import resolveSlash AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { resolveSlash } from "../daemon/session-slash.js";

// ---------------------------------------------------------------------------
// Tests — Session integration
// ---------------------------------------------------------------------------

describe("Session slash command — known", () => {
  beforeEach(() => {
    pendingRuns = [];
  });

  test("known slash command rewrites content before agent run", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    // Send a known slash command
    const promise = session.processMessage("/start-the-day", [], onEvent);
    await waitForPendingRun(1);

    // The message passed to agent loop should be rewritten
    const lastUserMsg =
      pendingRuns[0].messages[pendingRuns[0].messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const text = lastUserMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(text).toContain("slash command");
    expect(text).toContain("start-the-day");
    expect(text).toContain("Start the Day");
    // Should NOT contain the raw `/start-the-day` as the entire content
    expect(text).not.toBe("/start-the-day");

    resolveRun(0);
    await promise;
  });

  test("non-slash content is unchanged", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    const promise = session.processMessage("hello world", [], onEvent);
    await waitForPendingRun(1);

    const lastUserMsg =
      pendingRuns[0].messages[pendingRuns[0].messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    const text = lastUserMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(text).toContain("hello world");

    resolveRun(0);
    await promise;
  });

  test("trailing args are preserved in the rewritten content", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    const promise = session.processMessage(
      "/start-the-day weather in SF",
      [],
      onEvent,
    );
    await waitForPendingRun(1);

    const lastUserMsg =
      pendingRuns[0].messages[pendingRuns[0].messages.length - 1];
    const text = lastUserMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(text).toContain("weather in SF");
    expect(text).toContain("start-the-day");

    resolveRun(0);
    await promise;
  });

  test("unknown slash command does not trigger agent run and emits error", async () => {
    const session = makeSession();
    const events: ServerMessage[] = [];
    const onEvent = (msg: ServerMessage) => events.push(msg);

    await session.processMessage("/nonexistent-skill", [], onEvent);

    // No agent run should have been started
    expect(pendingRuns.length).toBe(0);

    // Should emit assistant_text_delta with the error message
    const textDeltas = events.filter((e) => e.type === "assistant_text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const errorText = (
      textDeltas[0] as {
        type: "assistant_text_delta";
        text: string;
      }
    ).text;
    expect(errorText).toContain("Unknown command `/nonexistent-skill`");
    expect(errorText).toContain("/start-the-day");

    // Should emit message_complete
    const completes = events.filter((e) => e.type === "message_complete");
    expect(completes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveSlash() direct unit tests
// ---------------------------------------------------------------------------

describe("resolveSlash — direct characterization", () => {
  test('known slash returns {kind: "rewritten"} with model-facing content and skillId', () => {
    const result = resolveSlash("/start-the-day");
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") throw new Error("unreachable");
    expect(result.content).toContain("slash command");
    expect(result.content).toContain("start-the-day");
    expect(result.content).toContain("Start the Day");
    // The rewritten content includes the skill ID instruction
    expect(result.content).toContain("ID: start-the-day");
    // It is NOT the raw user input
    expect(result.content).not.toBe("/start-the-day");
    // The skillId matches the owning skill's canonical ID
    expect(result.skillId).toBe("start-the-day");
  });

  test("known slash with trailing args includes args in rewritten content and skillId", () => {
    const result = resolveSlash("/start-the-day check emails and calendar");
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") throw new Error("unreachable");
    expect(result.content).toContain(
      "User arguments: check emails and calendar",
    );
    expect(result.skillId).toBe("start-the-day");
  });

  test('normal text returns {kind: "passthrough"} with content unchanged and no skillId', () => {
    const result = resolveSlash("hello world");
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") throw new Error("unreachable");
    expect(result.content).toBe("hello world");
    expect("skillId" in result).toBe(false);
  });

  test("path-like input returns passthrough (not treated as slash)", () => {
    const result = resolveSlash("/tmp/some-file.txt");
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") throw new Error("unreachable");
    expect(result.content).toBe("/tmp/some-file.txt");
  });

  test('unknown slash returns {kind: "unknown"} with message and no skillId', () => {
    const result = resolveSlash("/does-not-exist");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.message).toContain("Unknown command `/does-not-exist`");
    expect(result.message).toContain("/start-the-day");
    expect("skillId" in result).toBe(false);
  });

  test("empty input returns passthrough with no skillId", () => {
    const result = resolveSlash("");
    expect(result.kind).toBe("passthrough");
    if (result.kind !== "passthrough") throw new Error("unreachable");
    expect(result.content).toBe("");
    expect("skillId" in result).toBe(false);
  });
});
