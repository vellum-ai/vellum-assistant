/**
 * Integration tests for Twilio webhook route handlers.
 *
 * Tests:
 * - Signature valid/invalid/missing header
 * - Fail-closed behavior when auth token is not configured
 * - TWILIO_WEBHOOK_VALIDATION_DISABLED env flag bypass
 * - Duplicate callback replay (idempotency)
 * - Unknown status and malformed payload handling
 * - Handler-level idempotency concurrency (concurrent duplicates, failure-retry)
 */
import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'twilio-routes-test-')));

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

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
}));

// Configurable mock auth token — tests can switch between configured/unconfigured
let mockAuthToken: string | undefined = 'test-auth-token-for-webhooks';

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (account: string) => {
    if (account === 'credential:twilio:auth_token') return mockAuthToken;
    return undefined;
  },
}));

// Use the real TwilioConversationRelayProvider (not mocked) for signature validation
// but mock the instance methods that hit Twilio API
mock.module('../calls/twilio-provider.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac: createHmacNode } = require('node:crypto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { timingSafeEqual: timingSafeEqualNode } = require('node:crypto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSecureKey } = require('../security/secure-keys.js');

  return {
    TwilioConversationRelayProvider: class {
      readonly name = 'twilio';

      static getAuthToken(): string | null {
        return getSecureKey('credential:twilio:auth_token') ?? null;
      }

      static verifyWebhookSignature(
        url: string,
        params: Record<string, string>,
        signature: string,
        authToken: string,
      ): boolean {
        const sortedKeys = Object.keys(params).sort();
        let data = url;
        for (const key of sortedKeys) {
          data += key + params[key];
        }
        const computed = createHmacNode('sha1', authToken).update(data).digest('base64');
        const a = Buffer.from(computed);
        const b = Buffer.from(signature);
        if (a.length !== b.length) return false;
        return timingSafeEqualNode(a, b);
      }

      async initiateCall() { return { callSid: 'CA_mock_test' }; }
      async endCall() { return; }
    },
  };
});

// Configurable mock Twilio config — tests can override wssBaseUrl
let mockWssBaseUrl: string = 'wss://test.example.com';
let mockWebhookBaseUrl: string = 'https://test.example.com';

mock.module('../calls/twilio-config.js', () => ({
  getTwilioConfig: () => ({
    accountSid: 'AC_test',
    authToken: 'test-auth-token-for-webhooks',
    phoneNumber: '+15550001111',
    webhookBaseUrl: mockWebhookBaseUrl,
    wssBaseUrl: mockWssBaseUrl,
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import * as callStore from '../calls/call-store.js';
import {
  createCallSession,
  getCallSession,
  updateCallSession,
  getCallEvents,
  buildCallbackDedupeKey,
  claimCallback,
  releaseCallbackClaim,
} from '../calls/call-store.js';
import { resolveRelayUrl, handleStatusCallback } from '../calls/twilio-routes.js';
import { registerCallCompletionNotifier, unregisterCallCompletionNotifier } from '../calls/call-state.js';

initializeDb();

// ── Helpers ────────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-bearer-token-twilio-routes';
const AUTH_TOKEN = 'test-auth-token-for-webhooks';

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
  db.run('DELETE FROM processed_callbacks');
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

function computeSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}

function createTestSession(convId: string, callSid: string) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: 'twilio',
    fromNumber: '+15550001111',
    toNumber: '+15559998888',
    task: 'test task',
  });
  updateCallSession(session.id, { providerCallSid: callSid });
  return session;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('twilio webhook routes', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(() => {
    resetTables();
    mockAuthToken = AUTH_TOKEN;
    mockWssBaseUrl = 'wss://test.example.com';
    mockWebhookBaseUrl = 'https://test.example.com';
    delete process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({ port: 0, bearerToken: TEST_TOKEN });
    await server.start();
    port = server.actualPort;
  }

  async function stopServer(): Promise<void> {
    await server?.stop();
  }

  function statusUrl(): string {
    return `http://127.0.0.1:${port}/v1/calls/twilio/status`;
  }

  function buildFormBody(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  function signedRequest(
    url: string,
    params: Record<string, string>,
  ): { body: string; headers: Record<string, string> } {
    const body = buildFormBody(params);
    const sig = computeSignature(url, params, AUTH_TOKEN);
    return {
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': sig,
      },
    };
  }

  // ── Signature validation tests ─────────────────────────────────────

  describe('signature validation', () => {
    test('valid signature returns 200', async () => {
      await startServer();
      createTestSession('conv-sig-1', 'CA_sig_valid');
      const url = statusUrl();
      const params = { CallSid: 'CA_sig_valid', CallStatus: 'completed' };
      const { body, headers } = signedRequest(url, params);

      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      await stopServer();
    });

    test('missing X-Twilio-Signature header returns 403', async () => {
      await startServer();
      const url = statusUrl();
      const params = { CallSid: 'CA_no_sig', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Forbidden');

      await stopServer();
    });

    test('invalid signature returns 403', async () => {
      await startServer();
      const url = statusUrl();
      const params = { CallSid: 'CA_bad_sig', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': 'totally-wrong-signature',
        },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(403);

      await stopServer();
    });

    test('signature computed with wrong token returns 403', async () => {
      await startServer();
      const url = statusUrl();
      const params = { CallSid: 'CA_wrong_token', CallStatus: 'completed' };
      const wrongSig = computeSignature(url, params, 'wrong-auth-token');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': wrongSig,
        },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(403);

      await stopServer();
    });
  });

  // ── Fail-closed behavior ──────────────────────────────────────────

  describe('fail-closed when auth token missing', () => {
    test('returns 403 when auth token is not configured', async () => {
      mockAuthToken = undefined;
      await startServer();

      const url = statusUrl();
      const params = { CallSid: 'CA_no_token', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(403);

      await stopServer();
    });
  });

  // ── TWILIO_WEBHOOK_VALIDATION_DISABLED bypass ─────────────────────

  describe('validation disabled env flag', () => {
    test('skips validation when TWILIO_WEBHOOK_VALIDATION_DISABLED=true', async () => {
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = 'true';
      mockAuthToken = undefined; // Token not configured, but bypass should work
      await startServer();

      createTestSession('conv-bypass-1', 'CA_bypass');
      const url = statusUrl();
      const params = { CallSid: 'CA_bypass', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(200);

      await stopServer();
    });

    test('does NOT skip validation when TWILIO_WEBHOOK_VALIDATION_DISABLED is set but not "true"', async () => {
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = '1';
      mockAuthToken = undefined;
      await startServer();

      const url = statusUrl();
      const params = { CallSid: 'CA_no_bypass', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildFormBody(params),
      });

      // Should fail-closed: token missing and bypass not activated
      expect(res.status).toBe(403);

      await stopServer();
    });

    test('does NOT skip validation when env var is empty string', async () => {
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = '';
      mockAuthToken = undefined;
      await startServer();

      const url = statusUrl();
      const params = { CallSid: 'CA_empty_env', CallStatus: 'completed' };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildFormBody(params),
      });

      expect(res.status).toBe(403);

      await stopServer();
    });
  });

  // ── Callback idempotency / replay tests ───────────────────────────

  describe('callback idempotency', () => {
    test('replaying the same status callback does not create duplicate events', async () => {
      await startServer();
      const session = createTestSession('conv-idem-1', 'CA_idem_1');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_idem_1',
        CallStatus: 'in-progress',
        Timestamp: '2025-01-15T10:00:00Z',
      };
      const { body, headers } = signedRequest(url, params);

      // First callback — should process
      const res1 = await fetch(url, { method: 'POST', headers, body });
      expect(res1.status).toBe(200);

      // Second callback (replay) — should return 200 but not create new events
      const res2 = await fetch(url, { method: 'POST', headers, body });
      expect(res2.status).toBe(200);

      // Verify only one event was recorded
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);

      await stopServer();
    });

    test('different statuses for the same call create separate events', async () => {
      await startServer();
      const session = createTestSession('conv-idem-2', 'CA_idem_2');
      const url = statusUrl();

      // First: ringing
      const params1 = { CallSid: 'CA_idem_2', CallStatus: 'ringing', Timestamp: 'T1' };
      const req1 = signedRequest(url, params1);
      await fetch(url, { method: 'POST', headers: req1.headers, body: req1.body });

      // Second: in-progress (different status)
      const params2 = { CallSid: 'CA_idem_2', CallStatus: 'in-progress', Timestamp: 'T2' };
      const req2 = signedRequest(url, params2);
      await fetch(url, { method: 'POST', headers: req2.headers, body: req2.body });

      const events = getCallEvents(session.id);
      expect(events.length).toBe(2);

      await stopServer();
    });

    test('third replay of same callback is still no-op', async () => {
      await startServer();
      const session = createTestSession('conv-idem-3', 'CA_idem_3');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_idem_3',
        CallStatus: 'completed',
        Timestamp: '2025-01-15T11:00:00Z',
      };
      const { body, headers } = signedRequest(url, params);

      // Process three times
      await fetch(url, { method: 'POST', headers, body });
      await fetch(url, { method: 'POST', headers, body });
      await fetch(url, { method: 'POST', headers, body });

      const events = getCallEvents(session.id);
      const endedEvents = events.filter(e => e.eventType === 'call_ended');
      expect(endedEvents.length).toBe(1);

      await stopServer();
    });
  });

  // ── Unknown status + malformed payload tests ──────────────────────

  describe('unknown status and malformed payloads', () => {
    test('unknown Twilio status returns 200 but does not record event', async () => {
      await startServer();
      const session = createTestSession('conv-unknown-1', 'CA_unknown_1');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_unknown_1',
        CallStatus: 'some-future-status',
        Timestamp: 'T1',
      };
      const { body, headers } = signedRequest(url, params);

      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      const events = getCallEvents(session.id);
      expect(events.length).toBe(0);

      await stopServer();
    });

    test('missing CallSid returns 200 (graceful handling)', async () => {
      await startServer();
      const url = statusUrl();
      const params = { CallStatus: 'completed' };
      const { body, headers } = signedRequest(url, params);

      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      await stopServer();
    });

    test('missing CallStatus returns 200 (graceful handling)', async () => {
      await startServer();
      const url = statusUrl();
      const params = { CallSid: 'CA_no_status' };
      const { body, headers } = signedRequest(url, params);

      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      await stopServer();
    });

    test('CallSid not matching any session returns 200 without error', async () => {
      await startServer();
      const url = statusUrl();
      const params = {
        CallSid: 'CA_nonexistent_session',
        CallStatus: 'completed',
        Timestamp: 'T1',
      };
      const { body, headers } = signedRequest(url, params);

      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      await stopServer();
    });
  });

  describe('status mapping and completion notifications', () => {
    test('initiated status callback is accepted and recorded as call_started', async () => {
      const session = createTestSession('conv-status-init-1', 'CA_status_init_1');
      const params = new URLSearchParams({
        CallSid: 'CA_status_init_1',
        CallStatus: 'initiated',
        Timestamp: '2025-01-21T10:00:00Z',
      });

      const req = new Request('http://127.0.0.1/v1/calls/twilio/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('initiated');
      const events = getCallEvents(session.id);
      expect(events.filter((e) => e.eventType === 'call_started').length).toBe(1);
    });

    test('answered status callback transitions to in_progress', async () => {
      const session = createTestSession('conv-status-answered-1', 'CA_status_answered_1');
      const params = new URLSearchParams({
        CallSid: 'CA_status_answered_1',
        CallStatus: 'answered',
        Timestamp: '2025-01-21T10:05:00Z',
      });

      const req = new Request('http://127.0.0.1/v1/calls/twilio/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('in_progress');
      expect(updated!.startedAt).not.toBeNull();
      const events = getCallEvents(session.id);
      expect(events.filter((e) => e.eventType === 'call_connected').length).toBe(1);
    });

    test('completed status callback fires completion notifier when first entering terminal state', async () => {
      const session = createTestSession('conv-status-complete-1', 'CA_status_complete_1');
      updateCallSession(session.id, { status: 'in_progress', startedAt: Date.now() - 20_000 });
      const params = new URLSearchParams({
        CallSid: 'CA_status_complete_1',
        CallStatus: 'completed',
        Timestamp: '2025-01-21T10:10:00Z',
      });

      let fired = 0;
      registerCallCompletionNotifier('conv-status-complete-1', () => {
        fired += 1;
      });

      const req = new Request('http://127.0.0.1/v1/calls/twilio/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.endedAt).not.toBeNull();
      expect(fired).toBe(1);

      unregisterCallCompletionNotifier('conv-status-complete-1');
    });

    test('completed callback does not re-fire completion notifier for already terminal call', async () => {
      const session = createTestSession('conv-status-complete-2', 'CA_status_complete_2');
      updateCallSession(session.id, { status: 'completed', startedAt: Date.now() - 20_000, endedAt: Date.now() - 5_000 });
      const params = new URLSearchParams({
        CallSid: 'CA_status_complete_2',
        CallStatus: 'completed',
        Timestamp: '2025-01-21T10:15:00Z',
      });

      let fired = 0;
      registerCallCompletionNotifier('conv-status-complete-2', () => {
        fired += 1;
      });

      const req = new Request('http://127.0.0.1/v1/calls/twilio/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);
      expect(fired).toBe(0);

      unregisterCallCompletionNotifier('conv-status-complete-2');
    });
  });

  // ── resolveRelayUrl unit tests ──────────────────────────────────────

  describe('resolveRelayUrl', () => {
    test('uses wssBaseUrl when explicitly set', () => {
      const url = resolveRelayUrl('wss://ws.example.com', 'https://web.example.com');
      expect(url).toBe('wss://ws.example.com/v1/calls/relay');
    });

    test('falls back to webhookBaseUrl when wssBaseUrl is empty', () => {
      const url = resolveRelayUrl('', 'https://web.example.com');
      expect(url).toBe('wss://web.example.com/v1/calls/relay');
    });

    test('falls back to webhookBaseUrl when wssBaseUrl is whitespace-only', () => {
      const url = resolveRelayUrl('   ', 'https://web.example.com');
      expect(url).toBe('wss://web.example.com/v1/calls/relay');
    });

    test('normalizes http to ws in webhookBaseUrl fallback', () => {
      const url = resolveRelayUrl('', 'http://localhost:3000');
      expect(url).toBe('ws://localhost:3000/v1/calls/relay');
    });

    test('normalizes https to wss in webhookBaseUrl fallback', () => {
      const url = resolveRelayUrl('', 'https://gateway.example.com');
      expect(url).toBe('wss://gateway.example.com/v1/calls/relay');
    });

    test('strips trailing slash from wssBaseUrl', () => {
      const url = resolveRelayUrl('wss://ws.example.com/', 'https://web.example.com');
      expect(url).toBe('wss://ws.example.com/v1/calls/relay');
    });

    test('strips trailing slash from webhookBaseUrl fallback', () => {
      const url = resolveRelayUrl('', 'https://web.example.com/');
      expect(url).toBe('wss://web.example.com/v1/calls/relay');
    });

    test('preserves wss scheme in explicitly set wssBaseUrl', () => {
      const url = resolveRelayUrl('wss://custom-relay.example.com', 'https://web.example.com');
      expect(url).toBe('wss://custom-relay.example.com/v1/calls/relay');
    });
  });

  // ── TwiML relay URL generation ──────────────────────────────────────

  describe('voice webhook TwiML relay URL', () => {
    function voiceUrl(sessionId: string): string {
      return `http://127.0.0.1:${port}/v1/calls/twilio/voice-webhook?callSessionId=${sessionId}`;
    }

    test('TwiML uses explicit wssBaseUrl when set', async () => {
      mockWssBaseUrl = 'wss://explicit-ws.example.com';
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = 'true';
      await startServer();

      const session = createTestSession('conv-twiml-1', 'CA_twiml_1');
      const url = voiceUrl(session.id);
      const params = { CallSid: 'CA_twiml_1' };
      const body = buildFormBody(params);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain('wss://explicit-ws.example.com/v1/calls/relay');

      await stopServer();
    });

    test('TwiML falls back to webhookBaseUrl when wssBaseUrl is empty', async () => {
      mockWssBaseUrl = '';
      mockWebhookBaseUrl = 'https://gateway.example.com';
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = 'true';
      await startServer();

      const session = createTestSession('conv-twiml-2', 'CA_twiml_2');
      const url = voiceUrl(session.id);
      const params = { CallSid: 'CA_twiml_2' };
      const body = buildFormBody(params);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain('wss://gateway.example.com/v1/calls/relay');

      await stopServer();
    });
  });

  // ── Handler-level idempotency concurrency tests ─────────────────

  describe('handler-level idempotency concurrency', () => {
    test('two concurrent identical status callbacks produce exactly one event', async () => {
      await startServer();
      const session = createTestSession('conv-conc-1', 'CA_conc_1');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_conc_1',
        CallStatus: 'in-progress',
        Timestamp: '2025-01-20T10:00:00Z',
      };
      const { body, headers } = signedRequest(url, params);

      // Fire two identical callbacks concurrently
      const [res1, res2] = await Promise.all([
        fetch(url, { method: 'POST', headers, body }),
        fetch(url, { method: 'POST', headers, body }),
      ]);

      // Both should return 200 (one processes, one is deduplicated)
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Only one event should be recorded despite two concurrent requests
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);

      await stopServer();
    });

    test('three concurrent identical status callbacks still produce exactly one event', async () => {
      await startServer();
      const session = createTestSession('conv-conc-2', 'CA_conc_2');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_conc_2',
        CallStatus: 'completed',
        Timestamp: '2025-01-20T11:00:00Z',
      };
      const { body, headers } = signedRequest(url, params);

      // Fire three identical callbacks concurrently
      const [res1, res2, res3] = await Promise.all([
        fetch(url, { method: 'POST', headers, body }),
        fetch(url, { method: 'POST', headers, body }),
        fetch(url, { method: 'POST', headers, body }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res3.status).toBe(200);

      const events = getCallEvents(session.id);
      const endedEvents = events.filter(e => e.eventType === 'call_ended');
      expect(endedEvents.length).toBe(1);

      await stopServer();
    });

    test('processing failure releases claim and allows successful retry', async () => {
      await startServer();
      const session = createTestSession('conv-conc-3', 'CA_conc_3');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_conc_3',
        CallStatus: 'in-progress',
        Timestamp: '2025-01-20T12:00:00Z',
      };

      // Save original before spying so we can delegate on retry
      const originalRecordCallEvent = callStore.recordCallEvent;

      // Make recordCallEvent throw on the first call to exercise the handler's
      // real catch path (twilio-routes.ts:217), which calls
      // releaseCallbackClaim before re-throwing.
      let shouldThrow = true;
      const spy = spyOn(callStore, 'recordCallEvent').mockImplementation((...args: Parameters<typeof callStore.recordCallEvent>) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('Simulated side-effect failure');
        }
        spy.mockRestore();
        return originalRecordCallEvent(...args);
      });

      // Call handleStatusCallback directly (not through Bun.serve) so we can
      // catch the re-thrown error without Bun's HTTP server swallowing it.
      const formBody = new URLSearchParams(params).toString();
      const directReq = new Request(url, {
        method: 'POST',
        body: formBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      // The handler should claim → throw in recordCallEvent → catch releases claim → re-throw
      let handlerThrew = false;
      try {
        await handleStatusCallback(directReq);
      } catch (err) {
        handlerThrew = true;
        expect((err as Error).message).toBe('Simulated side-effect failure');
      }
      expect(handlerThrew).toBe(true);

      // No events recorded (the failed attempt rolled back via releaseCallbackClaim)
      const eventsAfterFailure = getCallEvents(session.id);
      expect(eventsAfterFailure.length).toBe(0);

      // Retry via the real HTTP handler — should succeed because the catch block
      // released the claim, allowing a fresh claim on retry.
      const { body, headers } = signedRequest(url, params);
      const res = await fetch(url, { method: 'POST', headers, body });
      expect(res.status).toBe(200);

      // Now exactly one event should exist from the successful retry
      const eventsAfterRetry = getCallEvents(session.id);
      const connectedEvents = eventsAfterRetry.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);

      await stopServer();
    });

    test('permanently claimed callback cannot be retried', async () => {
      await startServer();
      const session = createTestSession('conv-conc-4', 'CA_conc_4');
      const url = statusUrl();
      const params = {
        CallSid: 'CA_conc_4',
        CallStatus: 'completed',
        Timestamp: '2025-01-20T13:00:00Z',
      };
      const { body, headers } = signedRequest(url, params);

      // First request processes successfully and finalizes the claim
      const res1 = await fetch(url, { method: 'POST', headers, body });
      expect(res1.status).toBe(200);

      const events1 = getCallEvents(session.id);
      expect(events1.filter(e => e.eventType === 'call_ended').length).toBe(1);

      // Second request (retry) — should be deduplicated, no new events
      const res2 = await fetch(url, { method: 'POST', headers, body });
      expect(res2.status).toBe(200);

      const events2 = getCallEvents(session.id);
      expect(events2.filter(e => e.eventType === 'call_ended').length).toBe(1);

      await stopServer();
    });
  });
});
