/**
 * HTTP-layer integration tests for the standalone approval endpoints.
 *
 * Tests POST /v1/confirm, POST /v1/secret, and POST /v1/trust-rules
 * through RuntimeHttpServer with pending-interactions tracking.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
import type { Session } from "../daemon/session.js";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "approval-routes-http-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    sandbox: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
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

// Mock the trust store so addRule doesn't touch disk or require full config
mock.module("../permissions/trust-store.js", () => ({
  addRule: () => ({
    id: "test-rule",
    tool: "test",
    pattern: "*",
    scope: "everywhere",
    decision: "allow",
    priority: 100,
  }),
  getRules: () => [],
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function makeIdleSession(opts?: {
  onConfirmation?: (requestId: string, decision: string) => void;
  onSecret?: (requestId: string, value?: string, delivery?: string) => void;
}): Session {
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
      strictSideEffects: false,
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
    setHostBashProxy: () => {},
    setHostFileProxy: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    enqueueMessage: () => ({ queued: false, requestId: "noop" }),
    hasAnyPendingConfirmation: () => false,
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      onEvent({ type: "assistant_text_delta", text: "Hello!" });
      onEvent({ type: "message_complete", sessionId: "test-session" });
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
  } as unknown as Session;
}

/**
 * Session whose agent loop emits a confirmation_request, so the hub
 * publisher registers a pending interaction automatically.
 */
function makeConfirmationEmittingSession(opts?: {
  onConfirmation?: (requestId: string, decision: string) => void;
  confirmRequestId?: string;
  toolName?: string;
}): Session {
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
      strictSideEffects: false,
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
    setHostBashProxy: () => {},
    setHostFileProxy: () => {},
    setHostCuProxy: () => {},
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
        toolName: tool,
        input: { command: "ls" },
        riskLevel: "medium",
        allowlistOptions: [
          { label: "Allow ls", description: "Allow ls command", pattern: "ls" },
        ],
        scopeOptions: [{ label: "This session", scope: "session" }],
        persistentDecisionsAllowed: true,
      });
      // Hang to simulate waiting for decision
      await new Promise<void>(() => {});
    },
    handleConfirmationResponse: (requestId: string, decision: string) => {
      opts?.onConfirmation?.(requestId, decision);
    },
    handleSecretResponse: () => {},
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-bearer-token-approvals";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

describe("standalone approval endpoints — HTTP layer", () => {
  let server: RuntimeHttpServer;
  let port: number;
  let eventHub: AssistantEventHub;

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_keys");
    pendingInteractions.clear();
    eventHub = new AssistantEventHub();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  async function startServer(sessionFactory: () => Session): Promise<void> {
    port = 20000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({
      port,
      bearerToken: TEST_TOKEN,
      sendMessageDeps: {
        getOrCreateSession: async () => sessionFactory(),
        assistantEventHub: eventHub,
        resolveAttachments: () => [],
      },
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
        session,
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
        session,
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
      await startServer(() => makeIdleSession());

      const res = await fetch(url("confirm"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ requestId: "req-1", decision: "maybe" }),
      });

      expect(res.status).toBe(400);

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
        session,
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

  describe("POST /v1/trust-rules", () => {
    test("returns 404 for unknown requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "nonexistent",
          pattern: "ls",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(404);

      await stopServer();
    });

    test("returns 400 for missing requestId", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          pattern: "ls",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 400 for missing pattern", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-1",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 400 for missing scope", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-1",
          pattern: "ls",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 400 for invalid decision", async () => {
      await startServer(() => makeIdleSession());

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-1",
          pattern: "ls",
          scope: "session",
          decision: "maybe",
        }),
      });

      expect(res.status).toBe(400);

      await stopServer();
    });

    test("returns 409 when no confirmation details available", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      // Register without confirmationDetails
      pendingInteractions.register("req-no-details", {
        session,
        conversationId: "conv-1",
        kind: "secret",
      });

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-no-details",
          pattern: "ls",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(409);

      await stopServer();
    });

    test("returns 403 when persistent decisions are not allowed", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-no-persist", {
        session,
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "rm -rf" },
          riskLevel: "high",
          allowlistOptions: [
            { label: "Allow", description: "test", pattern: "rm" },
          ],
          scopeOptions: [{ label: "Session", scope: "session" }],
          persistentDecisionsAllowed: false,
        },
      });

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-no-persist",
          pattern: "rm",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(403);

      await stopServer();
    });

    test("returns 403 when pattern does not match allowlist", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-bad-pattern", {
        session,
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [
            { label: "Allow ls", description: "test", pattern: "ls" },
          ],
          scopeOptions: [{ label: "Session", scope: "session" }],
        },
      });

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-bad-pattern",
          pattern: "rm",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { message: string; code?: string };
      };
      expect(body.error.message).toContain("pattern");

      await stopServer();
    });

    test("returns 403 when scope does not match scope options", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-bad-scope", {
        session,
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [
            { label: "Allow ls", description: "test", pattern: "ls" },
          ],
          scopeOptions: [{ label: "Session", scope: "session" }],
        },
      });

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-bad-scope",
          pattern: "ls",
          scope: "global",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { message: string; code?: string };
      };
      expect(body.error.message).toContain("scope");

      await stopServer();
    });

    test("does not remove the pending interaction after adding trust rule", async () => {
      const session = makeIdleSession();
      await startServer(() => session);

      pendingInteractions.register("req-keep", {
        session,
        conversationId: "conv-1",
        kind: "confirmation",
        confirmationDetails: {
          toolName: "shell_command",
          input: { command: "ls" },
          riskLevel: "medium",
          allowlistOptions: [
            { label: "Allow ls", description: "test", pattern: "ls" },
          ],
          scopeOptions: [{ label: "Session", scope: "session" }],
        },
      });

      const res = await fetch(url("trust-rules"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          requestId: "req-keep",
          pattern: "ls",
          scope: "session",
          decision: "allow",
        }),
      });

      expect(res.status).toBe(200);

      // Interaction should still be present (not consumed)
      expect(pendingInteractions.get("req-keep")).toBeDefined();

      await stopServer();
    });
  });

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
        session,
        conversationId: "conv-x",
        kind: "confirmation",
      });
      pendingInteractions.register("req-b", {
        session,
        conversationId: "conv-x",
        kind: "secret",
      });
      pendingInteractions.register("req-c", {
        session,
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
