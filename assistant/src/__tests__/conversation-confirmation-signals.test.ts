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
import { describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
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
    rateLimit: { maxRequestsPerMinute: 0 },
    timeouts: { permissionTimeoutSec: 1 },
    skills: { entries: {}, allowBundled: true },
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

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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

mock.module("../memory/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
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
// Import Conversation AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";
import { HostBashProxy } from "../daemon/host-bash-proxy.js";
import { HostBrowserProxy } from "../daemon/host-browser-proxy.js";

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

function makeConversation(
  sendToClient?: (msg: ServerMessage) => void,
): Conversation {
  return new Conversation(
    "conv-signals-test",
    makeProvider(),
    "system prompt",
    4096,
    sendToClient ?? (() => {}),
    process.env.VELLUM_WORKSPACE_DIR!,
  );
}

/**
 * Seed a pending confirmation directly in the prompter's internal map.
 * This avoids calling `prompt()` which has complex side effects (sends
 * a confirmation_request message, needs allowlistOptions, etc.).
 */
function seedPendingConfirmation(
  conversation: Conversation,
  requestId: string,
): void {
  const prompter = conversation["prompter"] as unknown as {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("centralized confirmation emissions", () => {
  test("handleConfirmationResponse emits confirmation_state_changed with approved state for allow decision", () => {
    const emitted: ServerMessage[] = [];
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-allow-1");
    conversation.handleConfirmationResponse("req-allow-1", "allow");

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
      conversationId: "conv-signals-test",
      requestId: "req-allow-1",
      state: "approved",
      source: "button",
    });
  });

  test("handleConfirmationResponse emits confirmation_state_changed with denied state for deny decision", () => {
    const emitted: ServerMessage[] = [];
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-deny-1");
    conversation.handleConfirmationResponse("req-deny-1", "deny");

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
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-activity-1");
    conversation.handleConfirmationResponse("req-activity-1", "allow");

    const activityMsg = emitted.find(
      (m) =>
        m.type === "assistant_activity_state" &&
        "reason" in m &&
        (m as { reason: string }).reason === "confirmation_resolved",
    );
    expect(activityMsg).toBeDefined();
    expect(activityMsg).toMatchObject({
      type: "assistant_activity_state",
      conversationId: "conv-signals-test",
      phase: "thinking",
      reason: "confirmation_resolved",
      anchor: "assistant_turn",
    });
  });

  test("handleConfirmationResponse passes emissionContext source", () => {
    const emitted: ServerMessage[] = [];
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-ctx-1");
    conversation.handleConfirmationResponse(
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
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-always-deny");
    conversation.handleConfirmationResponse("req-always-deny", "always_deny");

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
    const conversation = makeConversation((msg) => emitted.push(msg));

    seedPendingConfirmation(conversation, "req-always-allow");
    conversation.handleConfirmationResponse("req-always-allow", "always_allow");

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
    const conversation = makeConversation((msg) => emitted.push(msg));

    conversation.emitActivityState(
      "thinking",
      "message_dequeued",
      "assistant_turn",
    );
    conversation.emitActivityState(
      "streaming",
      "first_text_delta",
      "assistant_turn",
    );
    conversation.emitActivityState(
      "tool_running",
      "tool_use_start",
      "assistant_turn",
    );
    conversation.emitActivityState("idle", "message_complete", "global");

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
    const conversation = makeConversation((msg) => emitted.push(msg));

    // Emit a baseline activity state
    conversation.emitActivityState(
      "thinking",
      "message_dequeued",
      "assistant_turn",
    );

    const baselineMsg = emitted.find(
      (m) => m.type === "assistant_activity_state",
    ) as ServerMessage & { activityVersion: number };
    const baselineVersion = baselineMsg.activityVersion;

    // Now handle a confirmation
    seedPendingConfirmation(conversation, "req-version-1");
    conversation.handleConfirmationResponse("req-version-1", "allow");

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
    const conversation = makeConversation((msg) => clientMsgs.push(msg));

    conversation.emitActivityState(
      "thinking",
      "message_dequeued",
      "assistant_turn",
    );

    expect(
      clientMsgs.filter((m) => m.type === "assistant_activity_state"),
    ).toHaveLength(1);
  });

  test("emitConfirmationStateChanged delivers to sendToClient", () => {
    const clientMsgs: ServerMessage[] = [];
    const conversation = makeConversation((msg) => clientMsgs.push(msg));

    conversation.emitConfirmationStateChanged({
      conversationId: "conv-signals-test",
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
    const conversation = makeConversation((msg) => clientMsgs.push(msg));

    seedPendingConfirmation(conversation, "req-signal-confirm");
    conversation.handleConfirmationResponse("req-signal-confirm", "allow");

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

describe("restoreBrowserProxyAvailability", () => {
  test("re-enables only the host browser proxy after clearProxyAvailability", () => {
    const conversation = makeConversation();
    const browserProxy = new HostBrowserProxy(() => {});
    const bashProxy = new HostBashProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);
    conversation.setHostBashProxy(bashProxy);

    // Mark as having a connected client (interactive desktop path).
    conversation.updateClient(() => {}, false);
    expect(browserProxy.isAvailable()).toBe(true);
    expect(bashProxy.isAvailable()).toBe(true);

    // The drain queue clears all proxies for non-interactive turns.
    conversation.clearProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(false);
    expect(bashProxy.isAvailable()).toBe(false);

    // restoreBrowserProxyAvailability should bring back ONLY the browser proxy.
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);
    expect(bashProxy.isAvailable()).toBe(false);
  });

  test("re-enables the browser proxy even when hasNoClient is true (chrome-extension)", () => {
    // Regression: chrome-extension is non-interactive (hasNoClient stays
    // true so host_bash/host_file tools remain gated), but we still need
    // to provision the hostBrowserProxy so it can service CDP commands.
    // The helper must NOT gate on hasNoClient.
    const conversation = makeConversation();
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // updateClient with hasNoClient=true emulates the non-interactive
    // chrome-extension turn. Host proxies start disabled because
    // updateClient propagates hasNoClient through to updateSender.
    conversation.updateClient(() => {}, true);
    expect(browserProxy.isAvailable()).toBe(false);
    expect(conversation["hasNoClient"]).toBe(true);

    // The targeted helper bypasses the hasNoClient gate so the
    // single-capability chrome-extension turn can drive the browser
    // via CDP without flipping hasNoClient (which would also enable
    // host_bash/host_file gating downstream).
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);
    // hasNoClient itself MUST remain true so that
    // isToolActiveForContext keeps host_bash/host_file/host_cu gated.
    expect(conversation["hasNoClient"]).toBe(true);
  });

  test("leaves bash/file/cu proxies disabled when called for chrome-extension", () => {
    // Regression: the targeted helper must not accidentally re-enable
    // proxies other than host_browser, even when called from a path that
    // owns multiple proxies (e.g. macOS holdover state with hasNoClient
    // forced true for an explicit non-interactive run).
    const conversation = makeConversation();
    const browserProxy = new HostBrowserProxy(() => {});
    const bashProxy = new HostBashProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);
    conversation.setHostBashProxy(bashProxy);

    conversation.updateClient(() => {}, true);
    expect(browserProxy.isAvailable()).toBe(false);
    expect(bashProxy.isAvailable()).toBe(false);

    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);
    // Crucial: bash proxy stays disabled. The helper must touch ONLY the
    // browser proxy.
    expect(bashProxy.isAvailable()).toBe(false);
  });

  test("uses hostBrowserSenderOverride when set so drain-queue restores preserve the registry-routed sender", () => {
    // Regression (PR #24129 cycle 2): the queue-drain path calls
    // `restoreBrowserProxyAvailability()` on dequeue, which used to pass
    // `this.sendToClient` (the SSE hub emitter) to the proxy, clobbering the
    // chrome-extension registry-routed sender established by the POST
    // /messages handler. The override field lets the HTTP handler pin the
    // registry-routed sender so the drain path preserves it.
    const sseHub: ServerMessage[] = [];
    const registry: ServerMessage[] = [];
    const conversation = makeConversation((msg) => sseHub.push(msg));
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // Simulate updateClient setting sendToClient to the SSE hub and
    // marking the conversation as client-less (chrome-extension is
    // non-interactive).
    conversation.updateClient((msg) => sseHub.push(msg), true);
    expect(browserProxy.isAvailable()).toBe(false);

    // The HTTP handler stashes the registry-routed sender as the override.
    const registrySender = (msg: ServerMessage) => registry.push(msg);
    conversation.hostBrowserSenderOverride = registrySender;

    // Drain-queue path calls restoreBrowserProxyAvailability — it must now
    // prefer the override over sendToClient.
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);

    // Send a frame through the proxy and verify it flows through the
    // registry sender, not the SSE hub.
    const internalSend = (
      browserProxy as unknown as {
        sendToClient: (msg: ServerMessage) => void;
      }
    ).sendToClient;
    const probe: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "probe-1",
    } as ServerMessage;
    internalSend(probe);
    expect(registry).toHaveLength(1);
    expect(sseHub.some((m) => m === probe)).toBe(false);
  });

  test("falls back to sendToClient when hostBrowserSenderOverride is cleared", () => {
    // When a non-chrome-extension turn takes over, the HTTP handler clears
    // the override and restoreBrowserProxyAvailability must fall back to
    // sendToClient (the SSE hub), otherwise macOS turns would route their
    // host_browser frames through the stale chrome-extension registry.
    const sseHub: ServerMessage[] = [];
    const conversation = makeConversation((msg) => sseHub.push(msg));
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // First the chrome-extension path pins the override.
    const registry: ServerMessage[] = [];
    conversation.hostBrowserSenderOverride = (msg) => registry.push(msg);
    conversation.updateClient((msg) => sseHub.push(msg), true);
    conversation.restoreBrowserProxyAvailability();

    // Then a macOS handoff clears the override.
    conversation.hostBrowserSenderOverride = undefined;
    conversation.updateClient((msg) => sseHub.push(msg), false);
    conversation.restoreBrowserProxyAvailability();

    const internalSend = (
      browserProxy as unknown as {
        sendToClient: (msg: ServerMessage) => void;
      }
    ).sendToClient;
    const probe: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "probe-2",
    } as ServerMessage;
    internalSend(probe);
    expect(sseHub).toContain(probe);
    expect(registry).not.toContain(probe);
  });
});

describe("hostBrowserSenderOverride is sender-mode based, not interface-string based", () => {
  test("macOS turn with registry override routes browser frames through the registry sender", () => {
    // When a macOS turn sets hostBrowserSenderOverride (because the
    // guardian has an active extension connection), the browser proxy
    // must route through the registry sender, not the SSE hub — the
    // same behavior chrome-extension turns have always used.
    const sseHub: ServerMessage[] = [];
    const registry: ServerMessage[] = [];
    const conversation = makeConversation((msg) => sseHub.push(msg));
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // macOS is interactive — hasNoClient is false.
    conversation.updateClient((msg) => sseHub.push(msg), false);

    // The POST /messages handler detected an active extension connection
    // and set the registry-routed sender override.
    const registrySender = (msg: ServerMessage) => registry.push(msg);
    conversation.hostBrowserSenderOverride = registrySender;

    // restoreBrowserProxyAvailability (called after updateClient in the
    // POST handler) must prefer the override.
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);

    // Verify frames flow through the registry, not the SSE hub.
    const internalSend = (
      browserProxy as unknown as {
        sendToClient: (msg: ServerMessage) => void;
      }
    ).sendToClient;
    const probe: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "probe-macos-registry",
    } as ServerMessage;
    internalSend(probe);
    expect(registry).toHaveLength(1);
    expect(sseHub.some((m) => m === probe)).toBe(false);
  });

  test("macOS turn without registry override clears the browser proxy on restore", () => {
    // When a macOS turn has no active extension connection, the override
    // is cleared and restoreBrowserProxyAvailability falls back to the
    // SSE hub sender. The proxy should not be stuck on an unavailable
    // registry-routed sender from a prior chrome-extension turn.
    const sseHub: ServerMessage[] = [];
    const conversation = makeConversation((msg) => sseHub.push(msg));
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // Interactive macOS turn without extension connectivity.
    conversation.updateClient((msg) => sseHub.push(msg), false);
    conversation.hostBrowserSenderOverride = undefined;
    conversation.restoreBrowserProxyAvailability();

    // The proxy should be available and routed through SSE.
    expect(browserProxy.isAvailable()).toBe(true);
    const internalSend = (
      browserProxy as unknown as {
        sendToClient: (msg: ServerMessage) => void;
      }
    ).sendToClient;
    const probe: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "probe-macos-sse",
    } as ServerMessage;
    internalSend(probe);
    expect(sseHub).toContain(probe);
  });

  test("override semantics are symmetric: chrome-extension and macOS both set override when registry-routed", () => {
    // The override field must be set for ANY interface that uses a
    // registry-routed sender, and cleared for any that does not.
    // This test verifies the field is not gated on interface strings.
    const conversation = makeConversation();
    const registrySender = () => {};

    // Simulate chrome-extension setting the override.
    conversation.hostBrowserSenderOverride = registrySender;
    expect(conversation.hostBrowserSenderOverride).toBe(registrySender);

    // Simulate macOS-with-extension setting the same override.
    // The field value is the same registry sender, not gated by interface.
    const macosRegistrySender = () => {};
    conversation.hostBrowserSenderOverride = macosRegistrySender;
    expect(conversation.hostBrowserSenderOverride).toBe(macosRegistrySender);

    // Simulate macOS-without-extension clearing the override.
    conversation.hostBrowserSenderOverride = undefined;
    expect(conversation.hostBrowserSenderOverride).toBeUndefined();
  });

  test("queue-drain restore path preserves registry-routed sender for macOS turns", () => {
    // When a macOS turn with an active extension connection has its
    // messages queued and later drained, the drain-queue path calls
    // restoreBrowserProxyAvailability(). With the override set, the
    // proxy must be restored with the registry sender, not the SSE hub.
    const sseHub: ServerMessage[] = [];
    const registry: ServerMessage[] = [];
    const conversation = makeConversation((msg) => sseHub.push(msg));
    const browserProxy = new HostBrowserProxy(() => {});
    conversation.setHostBrowserProxy(browserProxy);

    // macOS interactive turn with extension connectivity.
    conversation.updateClient((msg) => sseHub.push(msg), false);
    const registrySender = (msg: ServerMessage) => registry.push(msg);
    conversation.hostBrowserSenderOverride = registrySender;
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);

    // Simulate drain-queue clearing all proxies for a non-interactive
    // queued message, then restoring for the next macOS turn.
    conversation.clearProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(false);

    // Drain restore — override is still set from the POST handler.
    conversation.restoreBrowserProxyAvailability();
    expect(browserProxy.isAvailable()).toBe(true);

    // Verify the registry sender was preserved, not the SSE hub.
    const internalSend = (
      browserProxy as unknown as {
        sendToClient: (msg: ServerMessage) => void;
      }
    ).sendToClient;
    const probe: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "probe-drain-macos",
    } as ServerMessage;
    internalSend(probe);
    expect(registry).toHaveLength(1);
    expect(sseHub.some((m) => m === probe)).toBe(false);
  });
});
