/**
 * HTTP-layer integration tests for the standalone approval endpoints.
 *
 * Tests POST /v1/confirm, POST /v1/secret, and POST /v1/trust-rules
 * through RuntimeHttpServer with pending-interactions tracking.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    llm: {
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTokens: 64000,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: true, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 200000,
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
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-7",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

// Mock the trust store so addRule doesn't touch disk or require full config.
// Track calls to addRule so tests can verify canonicalization.
const addRuleCalls: Array<{
  tool: string;
  pattern: string;
  scope: string;
  decision: string;
  priority?: number;
  options?: { executionTarget?: string };
}> = [];
mock.module("../permissions/trust-store.js", () => ({
  addRule: (
    tool: string,
    pattern: string,
    scope: string,
    decision: string,
    priority?: number,
    options?: { executionTarget?: string },
  ) => {
    addRuleCalls.push({ tool, pattern, scope, decision, priority, options });
    return {
      id: "test-rule",
      tool,
      pattern,
      scope,
      decision,
      priority: priority ?? 100,
    };
  },
  getRules: () => [],
}));

// ---------------------------------------------------------------------------
// Module mocks for direct-import deps used by conversation-routes ROUTES
// ---------------------------------------------------------------------------
let _conversationFactory: (() => Conversation) | undefined;

mock.module("../daemon/conversation-store.js", () => ({
  findConversation: () => {
    // Return the current test session for any conversation ID lookup.
    if (!_conversationFactory) return undefined;
    return _conversationFactory();
  },
  getOrCreateConversation: async () => {
    if (!_conversationFactory)
      throw new Error("_conversationFactory not set in test");
    return _conversationFactory();
  },
}));
mock.module("../daemon/approval-generators.js", () => ({
  createApprovalConversationGenerator: () => undefined,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

function makeIdleSession(opts?: {
  onConfirmation?: (requestId: string, decision: string) => void;
  onSecret?: (requestId: string, value?: string, delivery?: string) => void;
}): Conversation {
  let processing = false;
  return {
    isProcessing: () => processing,
    persistUserMessage: (
      _content: string,
      _attachments: unknown[],
      requestId?: string,
    ) => {
      processing = true;
      return requestId ?? "msg-1";
    },
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    getMessages: () => [],
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    updateClient: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    enqueueMessage: () => ({ queued: false, requestId: "noop" }),
    hasAnyPendingConfirmation: () => false,
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      onEvent({ type: "assistant_text_delta", text: "Hello!" });
      onEvent({ type: "message_complete", conversationId: "test-session" });
      processing = false;
    },
    handleConfirmationResponse: (requestId: string, decision: string) => {
      opts?.onConfirmation?.(requestId, decision);
    },
    handleSecretResponse: (
      requestId: string,
      value?: string,
      delivery?: string,
    ) => {
      opts?.onSecret?.(requestId, value, delivery);
    },
  } as unknown as Conversation;
}

/**
 * Conversation whose agent loop emits a confirmation_request, so the hub
 * publisher registers a pending interaction automatically.
 */
function makeConfirmationEmittingSession(opts?: {
  onConfirmation?: (requestId: string, decision: string) => void;
  confirmRequestId?: string;
  toolName?: string;
}): Conversation {
  let processing = false;
  const reqId = opts?.confirmRequestId ?? "confirm-req-1";
  const tool = opts?.toolName ?? "shell_command";
  return {
    isProcessing: () => processing,
    persistUserMessage: (
      _content: string,
      _attachments: unknown[],
      requestId?: string,
    ) => {
      processing = true;
      return requestId ?? "msg-1";
    },
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    getMessages: () => [],
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    updateClient: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    enqueueMessage: () => ({ queued: false, requestId: "noop" }),
    hasAnyPendingConfirmation: () => false,
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      // Emit confirmation_request — this triggers the hub publisher to register
      // the pending interaction
      onEvent({
        type: "confirmation_request",
        requestId: reqId,
        conversationId: "conv-auto",
        toolName: tool,
        input: { command: "ls" },
        riskLevel: "medium",
        allowlistOptions: [
          { label: "Allow ls", description: "Allow ls command", pattern: "ls" },
        ],
        scopeOptions: [{ label: "This conversation", scope: "session" }],
        persistentDecisionsAllowed: true,
      });
      // Hang to simulate waiting for decision
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: (requestId: string, decision: string) => {
      opts?.onConfirmation?.(requestId, decision);
    },
    handleSecretResponse: () => {},
  } as unknown as Conversation;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-bearer-token-approvals";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe("standalone approval endpoints — HTTP layer", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let _eventHub: AssistantEventHub;

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");
    pendingInteractions.clear();
    addRuleCalls.length = 0;
    _eventHub = new AssistantEventHub();
  });

  async function startServer(
    conversationFactory: () => Conversation,
  ): Promise<void> {
    _conversationFactory = conversationFactory;
    port = 20000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({
      port,
    });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function url(path: string): string {
    return `http://127.0.0.1:${port}/v1/${path}`;
  }

  // ── POST /v1/confirm ─────────────────────────────────────────────────

  describe("POST /v1/confirm", () => {
    test("resolves a pending confirmation by requestId", async () => {
      let confirmedRequestId: string | undefined;
      let confirmedDecision: string | undefined;

      const session = makeIdleSession({
        onConfirmation: (reqId, dec) => {
          confirmedRequestId = reqId;
          confirmedDecision = dec;
        },
      });

      await startServer(() => session);

      // Manually register a pending interaction
      pendingInteractions.register("req-abc", {
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        },
      });

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "req-abc", decision: "allow" }),
      });
      const body = (await res.json()) as { accepted: boolean };

      expect(res.status).toBe(200);
      expect(body.accepted).toBe(true);
      expect(confirmedRequestId).toBe("req-abc");
      expect(confirmedDecision).toBe("allow");

      // Interaction should be removed after resolution
      expect(pendingInteractions.get("req-abc")).toBeUndefined();

      await stopServer();
    });

    test("returns 404 for unknown requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "nonexistent", decision: "allow" }),
      });

      expect(res.status).toBe(404);

      await stopServer();
    });

    test("returns 404 for already-resolved requestId", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-once", {
        conversationId: "conv-1",
        kind: "confirmation",
      });

      // First resolution succeeds
      const res1 = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "req-once", decision: "allow" }),
      });
      expect(res1.status).toBe(200);

      // Second resolution fails (already consumed)
      const res2 = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "req-once", decision: "deny" }),
      });
      expect(res2.status).toBe(404);

      await stopServer();
    });

    test("returns 400 for missing requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ decision: "allow" }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 400 for invalid decision", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-1", {
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        },
      });

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "req-1", decision: "maybe" }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("rejects temporal approval decisions (allow_10m is not a valid verb)", async () => {
      let confirmedDecision: string | undefined;

      const session = makeIdleSession({
        onConfirmation: (_reqId, dec) => {
          confirmedDecision = dec;
        },
      });

      await startServer(() => session);

      pendingInteractions.register("req-host-access", {
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "host_bash",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        },
      });

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-host-access",
          decision: "allow_10m",
        }),
      });
      const body = (await res.json()) as { error?: { message?: string } };

      // In PR3, temporal decisions (allow_10m) are no longer valid — only allow/deny
      // are accepted. The canonicalizeConfirmDecision function returns null for temporal
      // decisions, resulting in a 400 before the host-access-specific check.
      expect(res.status).toBe(400);
      expect(body.error?.message).toContain("resolve to allow or deny");
      expect(confirmedDecision).toBeUndefined();
      expect(pendingInteractions.get("req-host-access")).toBeDefined();

      await stopServer();
    });

    test("rejects legacy approval verbs (only allow/deny are accepted)", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-v2-invalid", {
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        },
      });

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-v2-invalid",
          decision: "allow_10m",
        }),
      });
      const body = (await res.json()) as { error?: { message?: string } };

      expect(res.status).toBe(400);
      expect(body.error?.message).toContain("resolve to allow or deny");
      expect(pendingInteractions.get("req-v2-invalid")).toBeDefined();

      await stopServer();
    });
  });

  // ── POST /v1/secret ──────────────────────────────────────────────────

  describe("POST /v1/secret", () => {
    test("resolves a pending secret request by requestId", async () => {
      let secretRequestId: string | undefined;
      let secretValue: string | undefined;
      let secretDelivery: string | undefined;

      const session = makeIdleSession({
        onSecret: (reqId, val, del) => {
          secretRequestId = reqId;
          secretValue = val;
          secretDelivery = del;
        },
      });

      await startServer(() => session);

      pendingInteractions.register("secret-req-1", {
        conversationId: "conv-1",
        kind: "secret",
      });

      const res = await fetch(url("secret"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "secret-req-1",
          value: "my-secret-key",
          delivery: "store",
        }),
      });
      const body = (await res.json()) as { accepted: boolean };

      expect(res.status).toBe(200);
      expect(body.accepted).toBe(true);
      expect(secretRequestId).toBe("secret-req-1");
      expect(secretValue).toBe("my-secret-key");
      expect(secretDelivery).toBe("store");

      // Interaction should be removed after resolution
      expect(pendingInteractions.get("secret-req-1")).toBeUndefined();

      await stopServer();
    });

    test("returns 404 for unknown requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("secret"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "nonexistent", value: "test" }),
      });

      expect(res.status).toBe(404);

      await stopServer();
    });

    test("returns 400 for missing requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("secret"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ value: "test" }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 400 for invalid delivery", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("secret"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-1",
          value: "test",
          delivery: "invalid",
        }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });
  });

  // ── POST /v1/trust-rules ─────────────────────────────────────────────

  // ── Hub publisher integration ────────────────────────────────────────

  describe("hub publisher registers pending interactions", () => {
    test("confirmation_request events register pending interactions", async () => {
      const confirmReceived: Array<{
        requestId: string;
        decision: string;
      }> = [];

      const session = makeConfirmationEmittingSession({
        confirmRequestId: "auto-req-1",
        toolName: "shell_command",
        onConfirmation: (reqId, dec) => {
          confirmReceived.push({ requestId: reqId, decision: dec });
        },
      });

      await startServer(() => session);

      // Send a message that triggers a confirmation_request
      const res = await fetch(url("messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          conversationKey: "conv-auto",
          content: "Run ls",
          sourceChannel: "vellum",
          interface: "macos",
        }),
      });
      expect(res.status).toBe(202);

      // Wait for the agent loop to emit the confirmation_request
      await new Promise((r) => setTimeout(r, 100));

      // The pending interaction should have been auto-registered
      const interaction = pendingInteractions.get("auto-req-1");
      expect(interaction).toBeDefined();
      expect(interaction!.kind).toBe("confirmation");
      expect(interaction!.confirmationDetails?.toolName).toBe("shell_command");

      // Now resolve it via the confirm endpoint
      const confirmRes = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "auto-req-1", decision: "allow" }),
      });
      expect(confirmRes.status).toBe(200);

      expect(confirmReceived).toHaveLength(1);
      expect(confirmReceived[0].requestId).toBe("auto-req-1");
      expect(confirmReceived[0].decision).toBe("allow");

      await stopServer();
    });
  });

  // ── getByConversation ────────────────────────────────────────────────

  describe("getByConversation", () => {
    test("returns all pending interactions for a conversation", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-a", {
        conversationId: "conv-x",
        kind: "confirmation",
      });
      pendingInteractions.register("req-b", {
        conversationId: "conv-x",
        kind: "secret",
      });
      pendingInteractions.register("req-c", {
        conversationId: "conv-y",
        kind: "confirmation",
      });

      const results = pendingInteractions.getByConversation("conv-x");
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.requestId).sort()).toEqual([
        "req-a",
        "req-b",
      ]);

      const resultsY = pendingInteractions.getByConversation("conv-y");
      expect(resultsY).toHaveLength(1);
      expect(resultsY[0].requestId).toBe("req-c");

      const resultsZ = pendingInteractions.getByConversation("conv-z");
      expect(resultsZ).toHaveLength(0);

      await stopServer();
    });
  });
});
