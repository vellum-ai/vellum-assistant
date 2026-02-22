/**
 * HTTP-layer integration tests for the call API endpoints.
 *
 * Tests POST /v1/calls/start, GET /v1/calls/:id,
 * POST /v1/calls/:id/cancel, and POST /v1/calls/:id/answer
 * through RuntimeHttpServer.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'call-routes-http-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const mockCallsConfig = {
  enabled: true,
  provider: 'twilio',
  maxDurationSeconds: 3600,
  userConsultTimeoutSeconds: 120,
  disclosure: { enabled: false, text: '' },
  safety: { denyCategories: [] },
  callerIdentity: {
    allowPerCallOverride: true,
  },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: mockCallsConfig,
  }),
  loadConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: mockCallsConfig,
    ingress: {
      enabled: true,
      publicBaseUrl: 'https://test.example.com',
    },
  }),
}));

// Mock Twilio provider to avoid real API calls
mock.module('../calls/twilio-provider.js', () => ({
  TwilioConversationRelayProvider: class {
    static getAuthToken() { return 'mock-auth-token'; }
    static verifyWebhookSignature() { return true; }
    async initiateCall() { return { callSid: 'CA_mock_sid_123' }; }
    async endCall() { return; }
  },
}));

// Mock Twilio config
mock.module('../calls/twilio-config.js', () => ({
  getTwilioConfig: () => ({
    accountSid: 'AC_test',
    authToken: 'test_token',
    phoneNumber: '+15550001111',
    webhookBaseUrl: 'https://test.example.com',
    wssBaseUrl: 'wss://test.example.com',
  }),
}));

// Mock secure keys
mock.module('../security/secure-keys.js', () => ({
  getSecureKey: () => null,
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import {
  createCallSession,
  updateCallSession,
  createPendingQuestion,
} from '../calls/call-store.js';
import '../calls/call-state.js';

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bearer-token-calls';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

let ensuredConvIds = new Set<string>();

function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Test conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime call routes — HTTP layer', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function startServer(): Promise<void> {
    port = 19000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function callsUrl(path = ''): string {
    return `http://127.0.0.1:${port}/v1/calls${path}`;
  }

  // ── POST /v1/calls/start ────────────────────────────────────────────

  test('POST /v1/calls/start returns 201 with call session', async () => {
    await startServer();
    ensureConversation('conv-start-1');

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: '+15559998888',
        task: 'Book a table for two',
        conversationId: 'conv-start-1',
      }),
    });

    expect(res.status).toBe(201);

    const body = await res.json() as {
      callSessionId: string;
      callSid: string;
      status: string;
      toNumber: string;
      fromNumber: string;
    };

    expect(body.callSessionId).toBeDefined();
    expect(body.callSid).toBe('CA_mock_sid_123');
    expect(body.status).toBe('initiated');
    expect(body.toNumber).toBe('+15559998888');
    expect(body.fromNumber).toBe('+15550001111');

    await stopServer();
  });

  test('POST /v1/calls/start returns 400 when conversationId missing', async () => {
    await startServer();

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: '+15559998888',
        task: 'Book a table',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('conversationId');

    await stopServer();
  });

  test('POST /v1/calls/start returns 400 for invalid phone number', async () => {
    await startServer();
    ensureConversation('conv-start-2');

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: 'not-a-number',
        task: 'Book a table',
        conversationId: 'conv-start-2',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('E.164');

    await stopServer();
  });

  test('POST /v1/calls/start returns 400 for malformed JSON', async () => {
    await startServer();

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'not-json{{',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid JSON');

    await stopServer();
  });

  test('POST /v1/calls/start with callerIdentityMode user_number is accepted', async () => {
    await startServer();
    ensureConversation('conv-start-identity-1');

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: '+15559998888',
        task: 'Book a table for two',
        conversationId: 'conv-start-identity-1',
        callerIdentityMode: 'user_number',
      }),
    });

    // user_number mode requires a configured user phone number;
    // since we haven't set one, this should return a 400 explaining why
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('user_number');

    await stopServer();
  });

  test('POST /v1/calls/start without callerIdentityMode defaults to assistant_number', async () => {
    await startServer();
    ensureConversation('conv-start-identity-2');

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: '+15559998888',
        task: 'Book a table for two',
        conversationId: 'conv-start-identity-2',
      }),
    });

    expect(res.status).toBe(201);

    const body = await res.json() as {
      callSessionId: string;
      callSid: string;
      status: string;
      toNumber: string;
      fromNumber: string;
      callerIdentityMode: string;
    };

    expect(body.callSessionId).toBeDefined();
    expect(body.callSid).toBe('CA_mock_sid_123');
    expect(body.fromNumber).toBe('+15550001111');
    expect(body.callerIdentityMode).toBe('assistant_number');

    await stopServer();
  });

  test('POST /v1/calls/start returns 400 for invalid callerIdentityMode', async () => {
    await startServer();
    ensureConversation('conv-start-identity-bogus');

    const res = await fetch(callsUrl('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({
        phoneNumber: '+15559998888',
        task: 'Book a table for two',
        conversationId: 'conv-start-identity-bogus',
        callerIdentityMode: 'bogus',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid callerIdentityMode');
    expect(body.error).toContain('bogus');
    expect(body.error).toContain('assistant_number');
    expect(body.error).toContain('user_number');

    await stopServer();
  });

  // ── GET /v1/calls/:id ───────────────────────────────────────────────

  test('GET /v1/calls/:id returns call status', async () => {
    await startServer();
    ensureConversation('conv-get-1');

    const session = createCallSession({
      conversationId: 'conv-get-1',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
      task: 'Test task',
    });

    const res = await fetch(callsUrl(`/${session.id}`), {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);

    const body = await res.json() as {
      callSessionId: string;
      status: string;
      toNumber: string;
      fromNumber: string;
      task: string;
      pendingQuestion: null;
    };

    expect(body.callSessionId).toBe(session.id);
    expect(body.status).toBe('initiated');
    expect(body.toNumber).toBe('+15559998888');
    expect(body.fromNumber).toBe('+15550001111');
    expect(body.task).toBe('Test task');
    expect(body.pendingQuestion).toBeNull();

    await stopServer();
  });

  test('GET /v1/calls/:id returns 404 for unknown session', async () => {
    await startServer();

    const res = await fetch(callsUrl('/nonexistent-id'), {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(404);

    await stopServer();
  });

  // ── POST /v1/calls/:id/cancel ──────────────────────────────────────

  test('POST /v1/calls/:id/cancel transitions to cancelled', async () => {
    await startServer();
    ensureConversation('conv-cancel-1');

    const session = createCallSession({
      conversationId: 'conv-cancel-1',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    const res = await fetch(callsUrl(`/${session.id}/cancel`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ reason: 'User requested' }),
    });

    expect(res.status).toBe(200);

    const body = await res.json() as { callSessionId: string; status: string };
    expect(body.callSessionId).toBe(session.id);
    expect(body.status).toBe('cancelled');

    await stopServer();
  });

  test('POST /v1/calls/:id/cancel returns 409 for already-ended call', async () => {
    await startServer();
    ensureConversation('conv-cancel-2');

    const session = createCallSession({
      conversationId: 'conv-cancel-2',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    updateCallSession(session.id, { status: 'completed', endedAt: Date.now() });

    const res = await fetch(callsUrl(`/${session.id}/cancel`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);

    await stopServer();
  });

  test('POST /v1/calls/:id/cancel returns 404 for unknown session', async () => {
    await startServer();

    const res = await fetch(callsUrl('/nonexistent-id/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);

    await stopServer();
  });

  // ── POST /v1/calls/:id/answer ──────────────────────────────────────

  test('POST /v1/calls/:id/answer returns 400 for malformed JSON', async () => {
    await startServer();
    ensureConversation('conv-answer-badjson');

    const session = createCallSession({
      conversationId: 'conv-answer-badjson',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: 'not-json{{',
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid JSON');

    await stopServer();
  });

  test('POST /v1/calls/:id/answer returns 404 when no pending question', async () => {
    await startServer();
    ensureConversation('conv-answer-1');

    const session = createCallSession({
      conversationId: 'conv-answer-1',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ answer: 'Yes, please' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('pending question');

    await stopServer();
  });

  test('POST /v1/calls/:id/answer returns 400 when answer is empty', async () => {
    await startServer();
    ensureConversation('conv-answer-2');

    const session = createCallSession({
      conversationId: 'conv-answer-2',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ answer: '' }),
    });

    expect(res.status).toBe(400);

    await stopServer();
  });

  test('POST /v1/calls/:id/answer returns 409 when no orchestrator', async () => {
    await startServer();
    ensureConversation('conv-answer-3');

    const session = createCallSession({
      conversationId: 'conv-answer-3',
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15559998888',
    });

    // Create a pending question but no orchestrator
    createPendingQuestion(session.id, 'What date do you prefer?');

    const res = await fetch(callsUrl(`/${session.id}/answer`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ answer: 'Tomorrow' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('orchestrator');

    await stopServer();
  });
});
