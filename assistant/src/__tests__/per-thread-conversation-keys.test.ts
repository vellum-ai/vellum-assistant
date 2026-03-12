/**
 * Tests for per-thread conversation keys (desktop multi-thread support).
 *
 * Covers:
 *   - Unscoped SSE subscription (no conversationKey) receives all events.
 *   - Scoped SSE subscription (with conversationKey) still works.
 *   - POST /v1/conversations/create returns a conversationId.
 *   - POST /v1/messages returns conversationId in 202 responses.
 *   - POST /v1/messages accepts conversationId instead of conversationKey.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "per-thread-keys-")));

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
    contextWindow: { maxInputTokens: 200000 },
  }),
}));

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../daemon/session-slash.js", () => ({
  resolveSlash: (_content: string) => ({
    kind: "passthrough",
    content: _content,
  }),
}));

mock.module("../daemon/session-process.js", () => ({
  buildModelInfoEvent: () => ({ type: "model_info" }),
  isModelSlashCommand: () => false,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({ id: "id", requestCode: "ABC" }),
  generateCanonicalRequestCode: () => "ABC",
  listPendingRequestsByConversationScope: () => [],
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: async (_conversationId: string, role: string) => ({
    id: role === "user" ? "user-msg-id" : "assistant-msg-id",
  }),
  getMessages: () => [],
  provenanceFromTrustContext: () => ({ provenanceTrustClass: "unknown" }),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import type { AuthContext } from "../runtime/auth/types.js";
import {
  handleCreateConversation,
  handleSendMessage,
} from "../runtime/routes/conversation-routes.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

const testAuthContext: AuthContext = {
  subject: "actor:self:test",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
  ]),
  policyEpoch: 1,
};

function makeSession() {
  const events: unknown[] = [];
  const messages: unknown[] = [];
  return {
    session: {
      setTrustContext: () => {},
      updateClient: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      ensureActorScopedHistory: async () => {},
      isProcessing: () => false,
      processing: false,
      hasAnyPendingConfirmation: () => false,
      hasPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: () => ({ queued: true, requestId: "q-id" }),
      persistUserMessage: async () => "user-msg-id",
      runAgentLoop: async () => {},
      setPreactivatedSkillIds: () => {},
      drainQueue: async () => {},
      getMessages: () => messages,
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      setHostBashProxy: () => {},
      setHostFileProxy: () => {},
      hostBashProxy: undefined,
      hostFileProxy: undefined,
      trustContext: undefined,
    },
    events,
  };
}

// ── SSE: Unscoped subscription ──────────────────────────────────────────────

describe("SSE — unscoped subscription (no conversationKey)", () => {
  beforeEach(clearTables);

  test("returns 200 without conversationKey", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 10 });
    const ac = new AbortController();
    const req = new Request("http://localhost/v1/events", {
      signal: ac.signal,
    });
    const res = handleSubscribeAssistantEvents(req, new URL(req.url), {
      hub,
      heartbeatIntervalMs: 60_000,
      skipActorVerification: true as const,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    ac.abort();
  });

  test("unscoped subscriber receives events from multiple sessions", async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 10 });
    const received: string[] = [];

    // Subscribe directly to the hub (bypassing SSE stream complexity)
    // to verify that an unscoped filter (no sessionId) receives all events.
    const sub = hub.subscribe({ assistantId: "ast_daemon" }, (event) => {
      if (event.sessionId) received.push(event.sessionId);
    });

    const event1 = buildAssistantEvent(
      "ast_daemon",
      { type: "assistant_text_delta", text: "hello from session1" },
      "session-1",
    );
    const event2 = buildAssistantEvent(
      "ast_daemon",
      { type: "assistant_text_delta", text: "hello from session2" },
      "session-2",
    );

    await hub.publish(event1);
    await hub.publish(event2);

    expect(received).toContain("session-1");
    expect(received).toContain("session-2");
    expect(received.length).toBe(2);

    sub.dispose();
  });
});

describe("SSE — scoped subscription (with conversationKey)", () => {
  beforeEach(clearTables);

  test("scoped subscriber only receives matching session events", async () => {
    const hub = new AssistantEventHub({ maxSubscribers: 10 });

    // Create a conversation for the key
    const mapping = getOrCreateConversation("scoped-key-1");
    const received: string[] = [];

    // Subscribe with a sessionId filter (same as what the SSE route does
    // when conversationKey is provided)
    const sub = hub.subscribe(
      { assistantId: "ast_daemon", sessionId: mapping.conversationId },
      (event) => {
        const msg = event.message as { text?: string };
        if (msg.text) received.push(msg.text);
      },
    );

    // Publish event for the scoped session
    const matchingEvent = buildAssistantEvent(
      "ast_daemon",
      { type: "assistant_text_delta", text: "scoped event" },
      mapping.conversationId,
    );
    // Publish event for a different session (should NOT be received)
    const otherEvent = buildAssistantEvent(
      "ast_daemon",
      { type: "assistant_text_delta", text: "other session" },
      "other-session-id",
    );

    await hub.publish(otherEvent);
    await hub.publish(matchingEvent);

    // Should only receive the matching event
    expect(received).toEqual(["scoped event"]);

    sub.dispose();
  });
});

// ── POST /v1/conversations/create ───────────────────────────────────────────

describe("POST /v1/conversations/create", () => {
  beforeEach(clearTables);

  test("creates a conversation and returns conversationId", async () => {
    const req = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: "vellum:test-create-1" }),
    });
    const res = await handleCreateConversation(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      conversationId: string;
      created: boolean;
    };
    expect(body.conversationId).toBeDefined();
    expect(typeof body.conversationId).toBe("string");
    expect(body.created).toBe(true);
  });

  test("returns existing conversation on duplicate key", async () => {
    const req1 = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: "vellum:test-create-dup" }),
    });
    const res1 = await handleCreateConversation(req1);
    const body1 = (await res1.json()) as {
      conversationId: string;
      created: boolean;
    };
    expect(body1.created).toBe(true);

    const req2 = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: "vellum:test-create-dup" }),
    });
    const res2 = await handleCreateConversation(req2);
    const body2 = (await res2.json()) as {
      conversationId: string;
      created: boolean;
    };
    expect(body2.created).toBe(false);
    expect(body2.conversationId).toBe(body1.conversationId);
  });

  test("different keys create different conversations", async () => {
    const req1 = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: "vellum:thread-a" }),
    });
    const req2 = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationKey: "vellum:thread-b" }),
    });

    const [res1, res2] = await Promise.all([
      handleCreateConversation(req1),
      handleCreateConversation(req2),
    ]);
    const body1 = (await res1.json()) as { conversationId: string };
    const body2 = (await res2.json()) as { conversationId: string };

    expect(body1.conversationId).not.toBe(body2.conversationId);
  });

  test("returns 400 without conversationKey", async () => {
    const req = new Request("http://localhost/v1/conversations/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await handleCreateConversation(req);
    expect(res.status).toBe(400);
  });
});

// ── POST /v1/messages — conversationId in response ──────────────────────────

describe("POST /v1/messages — conversationId in response", () => {
  beforeEach(clearTables);

  test("202 response includes conversationId", async () => {
    const { session } = makeSession();
    const hub = new AssistantEventHub({ maxSubscribers: 10 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationKey: "vellum:msg-test-1",
        content: "hello",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await handleSendMessage(
      req,
      {
        sendMessageDeps: {
          getOrCreateSession: async () => session as any,
          resolveAttachments: () => [],
          assistantEventHub: hub,
        },
      },
      testAuthContext,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      conversationId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBeDefined();
    expect(typeof body.conversationId).toBe("string");
  });

  test("accepts conversationId instead of conversationKey", async () => {
    // Pre-create a conversation
    const mapping = getOrCreateConversation("vellum:restored-thread");

    const { session } = makeSession();
    const hub = new AssistantEventHub({ maxSubscribers: 10 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: mapping.conversationId,
        content: "follow-up message",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await handleSendMessage(
      req,
      {
        sendMessageDeps: {
          getOrCreateSession: async () => session as any,
          resolveAttachments: () => [],
          assistantEventHub: hub,
        },
      },
      testAuthContext,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      conversationId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBe(mapping.conversationId);
  });

  test("returns 400 without conversationKey or conversationId", async () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hello",
        sourceChannel: "vellum",
        interface: "macos",
      }),
    });

    const res = await handleSendMessage(req, {}, testAuthContext);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("conversationKey or conversationId");
  });
});
