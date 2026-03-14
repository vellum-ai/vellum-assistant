/**
 * HTTP-layer integration tests for the call API endpoints.
 *
 * Tests POST /v1/calls/start, GET /v1/calls/:id,
 * POST /v1/calls/:id/cancel, and POST /v1/calls/:id/answer
 * through RuntimeHttpServer.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "call-routes-http-test-")),
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

const mockCallsConfig = {
  enabled: true,
  provider: "twilio",
  maxDurationSeconds: 3600,
  userConsultTimeoutSeconds: 120,
  disclosure: { enabled: false, text: "" },
  safety: { denyCategories: [] },
  callerIdentity: {
    allowPerCallOverride: true,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: mockCallsConfig,
  }),
  loadConfig: () => ({
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: mockCallsConfig,
    ingress: {
      enabled: true,
      publicBaseUrl: "https://test.example.com",
    },
  }),
}));

// Mock Twilio provider to avoid real API calls
mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    static getAuthToken() {
      return "mock-auth-token";
    }
    static verifyWebhookSignature() {
      return true;
    }
    async initiateCall() {
      return { callSid: "CA_mock_sid_123" };
    }
    async endCall() {
      return;
    }
  },
}));

// Mock Twilio config
mock.module("../calls/twilio-config.js", () => ({
  getTwilioConfig: (assistantId?: string) => ({
    accountSid: "AC_test",
    authToken: "test_token",
    phoneNumber: assistantId === "asst-alpha" ? "+15550009999" : "+15550001111",
    webhookBaseUrl: "https://test.example.com",
    wssBaseUrl: "wss://test.example.com",
  }),
}));

// Mock secure keys
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
}));

mock.module("../calls/voice-ingress-preflight.js", () => ({
  preflightVoiceIngress: async () => ({
    ok: true,
    publicBaseUrl: "https://test.example.com",
    ingressConfig: {
      ingress: {
        enabled: true,
        publicBaseUrl: "https://test.example.com",
      },
    },
  }),
}));

import {
  createCallSession,
  createPendingQuestion,
  updateCallSession,
} from "../calls/call-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

import "../calls/call-state.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-bearer-token-calls";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

let ensuredConvIds = new Set<string>();

function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Test conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM tool_invocations");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  ensuredConvIds = new Set();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtime call routes — HTTP layer", () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  async function startServer(): Promise<void> {
    port = 19000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function callsUrl(path = ""): string {
    return `http://127.0.0.1:${port}/v1/calls${path}`;
  }

  // ── POST /v1/calls/start ────────────────────────────────────────────

  test("POST /v1/calls/start returns 201 with call session", async () => {
    await startServer();
    ensureConversation("conv-start-1");

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "+15559998888",
        task: "Book a table for two",
        conversationId: "conv-start-1",
      }),
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      callSessionId: string;
      callSid: string;
      status: string;
      toNumber: string;
      fromNumber: string;
    };

    expect(body.callSessionId).toBeDefined();
    expect(body.callSid).toBe("CA_mock_sid_123");
    expect(body.status).toBe("initiated");
    expect(body.toNumber).toBe("+15559998888");
    expect(body.fromNumber).toBe("+15550001111");

    await stopServer();
  });

  test("POST /v1/calls/start returns 400 when conversationId missing", async () => {
    await startServer();

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "+15559998888",
        task: "Book a table",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("conversationId");

    await stopServer();
  });

  test("POST /v1/calls/start returns 400 for invalid phone number", async () => {
    await startServer();
    ensureConversation("conv-start-2");

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "not-a-number",
        task: "Book a table",
        conversationId: "conv-start-2",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("E.164");

    await stopServer();
  });

  test("POST /v1/calls/start returns 400 for malformed JSON", async () => {
    await startServer();

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: "not-json{{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("Invalid JSON");

    await stopServer();
  });

  test("POST /v1/calls/start with callerIdentityMode user_number is accepted", async () => {
    await startServer();
    ensureConversation("conv-start-identity-1");

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "+15559998888",
        task: "Book a table for two",
        conversationId: "conv-start-identity-1",
        callerIdentityMode: "user_number",
      }),
    });

    // user_number mode requires a configured user phone number;
    // since we haven't set one, this should return a 400 explaining why
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("user_number");

    await stopServer();
  });

  test("POST /v1/calls/start without callerIdentityMode defaults to assistant_number", async () => {
    await startServer();
    ensureConversation("conv-start-identity-2");

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "+15559998888",
        task: "Book a table for two",
        conversationId: "conv-start-identity-2",
      }),
    });

    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      callSessionId: string;
      callSid: string;
      status: string;
      toNumber: string;
      fromNumber: string;
      callerIdentityMode: string;
    };

    expect(body.callSessionId).toBeDefined();
    expect(body.callSid).toBe("CA_mock_sid_123");
    expect(body.fromNumber).toBe("+15550001111");
    expect(body.callerIdentityMode).toBe("assistant_number");

    await stopServer();
  });

  test("POST /v1/calls/start returns 400 for invalid callerIdentityMode", async () => {
    await startServer();
    ensureConversation("conv-start-identity-bogus");

    const res = await fetch(callsUrl("/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: "+15559998888",
        task: "Book a table for two",
        conversationId: "conv-start-identity-bogus",
        callerIdentityMode: "bogus",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("Invalid callerIdentityMode");
    expect(body.error.message).toContain("bogus");
    expect(body.error.message).toContain("assistant_number");
    expect(body.error.message).toContain("user_number");

    await stopServer();
  });

  // ── GET /v1/calls/:id ───────────────────────────────────────────────

  test("GET /v1/calls/:id returns call status", async () => {
    await startServer();
    ensureConversation("conv-get-1");

    const session = createCallSession({
      conversationId: "conv-get-1",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
      task: "Test task",
    });

    const res = await fetch(callsUrl(`/${session.id}`), {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      callSessionId: string;
      status: string;
      toNumber: string;
      fromNumber: string;
      task: string;
      pendingQuestion: null;
    };

    expect(body.callSessionId).toBe(session.id);
    expect(body.status).toBe("initiated");
    expect(body.toNumber).toBe("+15559998888");
    expect(body.fromNumber).toBe("+15550001111");
    expect(body.task).toBe("Test task");
    expect(body.pendingQuestion).toBeNull();

    await stopServer();
  });

  test("GET /v1/calls/:id returns 404 for unknown session", async () => {
    await startServer();

    const res = await fetch(callsUrl("/nonexistent-id"), {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(404);

    await stopServer();
  });

  // ── POST /v1/calls/:id/cancel ──────────────────────────────────────

  test("POST /v1/calls/:id/cancel transitions to cancelled", async () => {
    await startServer();
    ensureConversation("conv-cancel-1");

    const session = createCallSession({
      conversationId: "conv-cancel-1",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/cancel`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ reason: "User requested" }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      callSessionId: string;
      status: string;
    };
    expect(body.callSessionId).toBe(session.id);
    expect(body.status).toBe("cancelled");

    await stopServer();
  });

  test("POST /v1/calls/:id/cancel returns 409 for already-ended call", async () => {
    await startServer();
    ensureConversation("conv-cancel-2");

    const session = createCallSession({
      conversationId: "conv-cancel-2",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    updateCallSession(session.id, { status: "completed", endedAt: Date.now() });

    const res = await fetch(callsUrl(`/${session.id}/cancel`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);

    await stopServer();
  });

  test("POST /v1/calls/:id/cancel returns 404 for unknown session", async () => {
    await startServer();

    const res = await fetch(callsUrl("/nonexistent-id/cancel"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);

    await stopServer();
  });

  // ── POST /v1/calls/:id/answer ──────────────────────────────────────

  test("POST /v1/calls/:id/answer returns 400 for malformed JSON", async () => {
    await startServer();
    ensureConversation("conv-answer-badjson");

    const session = createCallSession({
      conversationId: "conv-answer-badjson",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: "not-json{{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("Invalid JSON");

    await stopServer();
  });

  test("POST /v1/calls/:id/answer returns 404 when no pending question", async () => {
    await startServer();
    ensureConversation("conv-answer-1");

    const session = createCallSession({
      conversationId: "conv-answer-1",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ answer: "Yes, please" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("No active controller");

    await stopServer();
  });

  test("POST /v1/calls/:id/answer returns 400 when answer is empty", async () => {
    await startServer();
    ensureConversation("conv-answer-2");

    const session = createCallSession({
      conversationId: "conv-answer-2",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ answer: "" }),
    });

    expect(res.status).toBe(400);

    await stopServer();
  });

  test("POST /v1/calls/:id/answer returns 409 when no orchestrator", async () => {
    await startServer();
    ensureConversation("conv-answer-3");

    const session = createCallSession({
      conversationId: "conv-answer-3",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    // Create a pending question but no orchestrator
    createPendingQuestion(session.id, "What date do you prefer?");

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ answer: "Tomorrow" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("No active controller");

    await stopServer();
  });

  // ── POST /v1/calls/:id/instruction ────────────────────────────────

  test("POST /v1/calls/:id/instruction returns 400 for malformed JSON", async () => {
    await startServer();
    ensureConversation("conv-instr-badjson");

    const session = createCallSession({
      conversationId: "conv-instr-badjson",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/instruction`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: "not-json{{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("Invalid JSON");

    await stopServer();
  });

  test("POST /v1/calls/:id/instruction returns 400 when instruction is empty", async () => {
    await startServer();
    ensureConversation("conv-instr-empty");

    const session = createCallSession({
      conversationId: "conv-instr-empty",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/instruction`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ instruction: "" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("instructionText");

    await stopServer();
  });

  test("POST /v1/calls/:id/instruction returns 400 when instruction field is missing", async () => {
    await startServer();
    ensureConversation("conv-instr-missing");

    const session = createCallSession({
      conversationId: "conv-instr-missing",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/instruction`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("instructionText");

    await stopServer();
  });

  test("POST /v1/calls/:id/instruction returns 404 for unknown session", async () => {
    await startServer();

    const res = await fetch(callsUrl("/nonexistent-id/instruction"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ instruction: "Speed things up" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("No call session found");

    await stopServer();
  });

  test("POST /v1/calls/:id/instruction returns 409 for ended call", async () => {
    await startServer();
    ensureConversation("conv-instr-ended");

    const session = createCallSession({
      conversationId: "conv-instr-ended",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    updateCallSession(session.id, { status: "completed", endedAt: Date.now() });

    const res = await fetch(callsUrl(`/${session.id}/instruction`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ instruction: "Speed things up" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("not active");

    await stopServer();
  });

  test("POST /v1/calls/:id/instruction returns 409 when no orchestrator", async () => {
    await startServer();
    ensureConversation("conv-instr-no-orch");

    const session = createCallSession({
      conversationId: "conv-instr-no-orch",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15559998888",
    });

    const res = await fetch(callsUrl(`/${session.id}/instruction`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ instruction: "Speed things up" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.message).toContain("No active controller");

    await stopServer();
  });
});
