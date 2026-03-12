/**
 * Behavioral tests for centralized confirmation state emissions and
 * activity version ordering.
 *
 * Covers:
 * - handleConfirmationResponse emits both confirmation_state_changed and
 *   assistant_activity_state events centrally
 * - emitActivityState produces monotonically increasing activityVersion
 * - sendToClient receives state signals (confirmation_state_changed, assistant_activity_state)
 * - "deny" decisions produce 'denied' state, "allow" produces 'approved'
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

const testDir = mkdtempSync(
  join(tmpdir(), "session-confirmation-signals-test-"),
);

// ---------------------------------------------------------------------------
// Mocks — must precede Session import
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
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
    },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    timeouts: { permissionTimeoutSec: 1 },
    apiKeys: {},
    skills: { entries: {}, allowBundled: true },
    memory: { retrieval: { injectionStrategy: "inline" } },
    permissions: { mode: "workspace" },
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

mock.module("../memory/admin.js", () => ({
  getMemoryCleanupStats: () => ({
    cleanup: {
      supersededBacklog: 0,
      supersededCompleted24h: 0,
    },
  }),
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
  addMessage: () => ({ id: `msg-${Date.now()}` }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
}));

mock.module("../memory/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {},
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

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    async run(
      _messages: Message[],
      _onEvent: (event: AgentEvent) => void,
      _signal?: AbortSignal,
      _requestId?: string,
      _onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
    ): Promise<Message[]> {
      return [];
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
// Import Session AFTER mocks
// ---------------------------------------------------------------------------

import { Session } from "../daemon/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return {
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
}

function makeSession(sendToClient?: (msg: ServerMessage) => void): Session {
  return new Session(
    "conv-signals-test",
    makeProvider(),
    "system prompt",
    4096,
    sendToClient ?? (() => {}),
    testDir,
  );
}

/**
 * Seed a pending confirmation directly in the prompter's internal map.
 * This avoids calling `prompt()` which has complex side effects (sends
 * a confirmation_request message, needs allowlistOptions, etc.).
 */
function seedPendingConfirmation(session: Session, requestId: string): void {
  const prompter = session["prompter"] as unknown as {
    pending: Map<
      string,
      {
        resolve: (...args: unknown[]) => void;
        reject: (...args: unknown[]) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >;
  };
  prompter.pending.set(requestId, {
    resolve: () => {},
    reject: () => {},
    timer: setTimeout(() => {}, 60_000),
  });
}

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("centralized confirmation emissions", () => {
  test("handleConfirmationResponse emits confirmation_state_changed with approved state for allow decision", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-allow-1");
    session.handleConfirmationResponse("req-allow-1", "allow");

    const confirmMsgs = emitted.filter(
      (m) => m.type === "confirmation_state_changed",
    );
    // Filter to our explicitly requested emission (not the pending/timed_out ones from prompter)
    const confirmMsg = confirmMsgs.find(
      (m) =>
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-allow-1" &&
        "state" in m &&
        (m as { state: string }).state === "approved",
    );
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toMatchObject({
      type: "confirmation_state_changed",
      sessionId: "conv-signals-test",
      requestId: "req-allow-1",
      state: "approved",
      source: "button",
    });
  });

  test("handleConfirmationResponse emits confirmation_state_changed with denied state for deny decision", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-deny-1");
    session.handleConfirmationResponse("req-deny-1", "deny");

    const confirmMsg = emitted.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-deny-1" &&
        "state" in m &&
        (m as { state: string }).state === "denied",
    );
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toMatchObject({
      type: "confirmation_state_changed",
      requestId: "req-deny-1",
      state: "denied",
      source: "button",
    });
  });

  test("handleConfirmationResponse emits assistant_activity_state with thinking phase", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-activity-1");
    session.handleConfirmationResponse("req-activity-1", "allow");

    const activityMsg = emitted.find(
      (m) =>
        m.type === "assistant_activity_state" &&
        "reason" in m &&
        (m as { reason: string }).reason === "confirmation_resolved",
    );
    expect(activityMsg).toBeDefined();
    expect(activityMsg).toMatchObject({
      type: "assistant_activity_state",
      sessionId: "conv-signals-test",
      phase: "thinking",
      reason: "confirmation_resolved",
      anchor: "assistant_turn",
    });
  });

  test("handleConfirmationResponse passes emissionContext source", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-ctx-1");
    session.handleConfirmationResponse(
      "req-ctx-1",
      "allow",
      undefined,
      undefined,
      undefined,
      {
        source: "inline_nl",
        decisionText: "yes please",
      },
    );

    const confirmMsg = emitted.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-ctx-1",
    );
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toMatchObject({
      source: "inline_nl",
      decisionText: "yes please",
    });
  });

  test("always_deny produces denied state", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-always-deny");
    session.handleConfirmationResponse("req-always-deny", "always_deny");

    const confirmMsg = emitted.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-always-deny",
    );
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toMatchObject({
      state: "denied",
    });
  });

  test("always_allow produces approved state", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    seedPendingConfirmation(session, "req-always-allow");
    session.handleConfirmationResponse("req-always-allow", "always_allow");

    const confirmMsg = emitted.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-always-allow",
    );
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toMatchObject({
      state: "approved",
    });
  });
});

describe("activity version ordering", () => {
  test("emitActivityState produces monotonically increasing activityVersion", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    session.emitActivityState("thinking", "message_dequeued", "assistant_turn");
    session.emitActivityState(
      "streaming",
      "first_text_delta",
      "assistant_turn",
    );
    session.emitActivityState(
      "tool_running",
      "tool_use_start",
      "assistant_turn",
    );
    session.emitActivityState("idle", "message_complete", "global");

    const activityMsgs = emitted.filter(
      (m) => m.type === "assistant_activity_state",
    ) as Array<ServerMessage & { activityVersion: number }>;

    expect(activityMsgs).toHaveLength(4);

    // Versions must be strictly increasing
    for (let i = 1; i < activityMsgs.length; i++) {
      expect(activityMsgs[i].activityVersion).toBeGreaterThan(
        activityMsgs[i - 1].activityVersion,
      );
    }

    // First version must be >= 1
    expect(activityMsgs[0].activityVersion).toBeGreaterThanOrEqual(1);
  });

  test("handleConfirmationResponse increments activityVersion for its activity emission", () => {
    const emitted: ServerMessage[] = [];
    const session = makeSession((msg) => emitted.push(msg));

    // Emit a baseline activity state
    session.emitActivityState("thinking", "message_dequeued", "assistant_turn");

    const baselineMsg = emitted.find(
      (m) => m.type === "assistant_activity_state",
    ) as ServerMessage & { activityVersion: number };
    const baselineVersion = baselineMsg.activityVersion;

    // Now handle a confirmation
    seedPendingConfirmation(session, "req-version-1");
    session.handleConfirmationResponse("req-version-1", "allow");

    const activityMsgs = emitted.filter(
      (m) => m.type === "assistant_activity_state",
    ) as Array<ServerMessage & { activityVersion: number; reason: string }>;

    // The confirmation_resolved activity message should have a higher version
    const resolvedMsg = activityMsgs.find(
      (m) => m.reason === "confirmation_resolved",
    );
    expect(resolvedMsg).toBeDefined();
    expect(resolvedMsg!.activityVersion).toBeGreaterThan(baselineVersion);
  });
});

describe("sendToClient receives state signals", () => {
  test("emitActivityState delivers to sendToClient", () => {
    const clientMsgs: ServerMessage[] = [];
    const session = makeSession((msg) => clientMsgs.push(msg));

    session.emitActivityState("thinking", "message_dequeued", "assistant_turn");

    expect(
      clientMsgs.filter((m) => m.type === "assistant_activity_state"),
    ).toHaveLength(1);
  });

  test("emitConfirmationStateChanged delivers to sendToClient", () => {
    const clientMsgs: ServerMessage[] = [];
    const session = makeSession((msg) => clientMsgs.push(msg));

    session.emitConfirmationStateChanged({
      sessionId: "conv-signals-test",
      requestId: "req-signal-1",
      state: "approved",
      source: "button",
    });

    expect(
      clientMsgs.filter((m) => m.type === "confirmation_state_changed"),
    ).toHaveLength(1);
  });

  test("handleConfirmationResponse delivers state signals to sendToClient", () => {
    const clientMsgs: ServerMessage[] = [];
    const session = makeSession((msg) => clientMsgs.push(msg));

    seedPendingConfirmation(session, "req-signal-confirm");
    session.handleConfirmationResponse("req-signal-confirm", "allow");

    const confirmSignal = clientMsgs.find(
      (m) =>
        m.type === "confirmation_state_changed" &&
        "requestId" in m &&
        (m as { requestId: string }).requestId === "req-signal-confirm",
    );
    const activitySignal = clientMsgs.find(
      (m) =>
        m.type === "assistant_activity_state" &&
        "reason" in m &&
        (m as { reason: string }).reason === "confirmation_resolved",
    );

    expect(confirmSignal).toBeDefined();
    expect(confirmSignal).toMatchObject({
      state: "approved",
      requestId: "req-signal-confirm",
    });

    expect(activitySignal).toBeDefined();
    expect(activitySignal).toMatchObject({
      phase: "thinking",
      reason: "confirmation_resolved",
    });
  });
});
