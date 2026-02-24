/**
 * Integration tests for Twilio webhook route handlers.
 *
 * Tests handler-level behavior by calling route handlers directly (not via HTTP
 * server). Gateway-only blocking of direct webhook routes is covered in the
 * dedicated `gateway-only-enforcement.test.ts` suite.
 *
 * Tests:
 * - Duplicate callback replay (idempotency)
 * - Unknown status and malformed payload handling
 * - Status mapping and completion notifications
 * - resolveRelayUrl unit behavior
 * - Voice webhook TwiML relay URL generation
 * - Handler-level idempotency concurrency (concurrent duplicates, failure-retry)
 */
import { describe, test, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
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

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: () => undefined,
}));

mock.module('../calls/twilio-provider.js', () => ({
  TwilioConversationRelayProvider: class {
    readonly name = 'twilio';
    static getAuthToken(): string | null { return null; }
    static verifyWebhookSignature(): boolean { return true; }
    async initiateCall() { return { callSid: 'CA_mock_test' }; }
    async endCall() { return; }
  },
}));

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
import * as callStore from '../calls/call-store.js';
import {
  createCallSession,
  getCallSession,
  updateCallSession,
  getCallEvents,
} from '../calls/call-store.js';
import { resolveRelayUrl, buildWelcomeGreeting, handleStatusCallback, handleVoiceWebhook } from '../calls/twilio-routes.js';
import { registerCallCompletionNotifier, unregisterCallCompletionNotifier } from '../calls/call-state.js';

initializeDb();

// ── Helpers ────────────────────────────────────────────────────────────

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

function createTestSession(convId: string, callSid: string, task = 'test task') {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: 'twilio',
    fromNumber: '+15550001111',
    toNumber: '+15559998888',
    task,
  });
  updateCallSession(session.id, { providerCallSid: callSid });
  return session;
}

function makeStatusRequest(params: Record<string, string>): Request {
  return new Request('http://127.0.0.1/v1/calls/twilio/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

function makeVoiceRequest(sessionId: string, params: Record<string, string>): Request {
  return new Request(`http://127.0.0.1/v1/calls/twilio/voice-webhook?callSessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('twilio webhook routes', () => {
  beforeEach(() => {
    resetTables();
    mockWssBaseUrl = 'wss://test.example.com';
    mockWebhookBaseUrl = 'https://test.example.com';
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── Callback idempotency / replay tests ───────────────────────────
  // These call handleStatusCallback directly (bypassing the HTTP server)
  // since direct routes are blocked by gateway-only mode.

  describe('callback idempotency', () => {
    test('replaying the same status callback does not create duplicate events', async () => {
      const session = createTestSession('conv-idem-1', 'CA_idem_1');
      const params = {
        CallSid: 'CA_idem_1',
        CallStatus: 'in-progress',
        Timestamp: '2025-01-15T10:00:00Z',
      };

      // First callback — should process
      const res1 = await handleStatusCallback(makeStatusRequest(params));
      expect(res1.status).toBe(200);

      // Second callback (replay) — should return 200 but not create new events
      const res2 = await handleStatusCallback(makeStatusRequest(params));
      expect(res2.status).toBe(200);

      // Verify only one event was recorded
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);
    });

    test('different statuses for the same call create separate events', async () => {
      const session = createTestSession('conv-idem-2', 'CA_idem_2');

      // First: ringing
      await handleStatusCallback(makeStatusRequest({
        CallSid: 'CA_idem_2', CallStatus: 'ringing', Timestamp: 'T1',
      }));

      // Second: in-progress (different status)
      await handleStatusCallback(makeStatusRequest({
        CallSid: 'CA_idem_2', CallStatus: 'in-progress', Timestamp: 'T2',
      }));

      const events = getCallEvents(session.id);
      expect(events.length).toBe(2);
    });

    test('third replay of same callback is still no-op', async () => {
      const session = createTestSession('conv-idem-3', 'CA_idem_3');
      const params = {
        CallSid: 'CA_idem_3',
        CallStatus: 'completed',
        Timestamp: '2025-01-15T11:00:00Z',
      };

      // Process three times
      await handleStatusCallback(makeStatusRequest(params));
      await handleStatusCallback(makeStatusRequest(params));
      await handleStatusCallback(makeStatusRequest(params));

      const events = getCallEvents(session.id);
      const endedEvents = events.filter(e => e.eventType === 'call_ended');
      expect(endedEvents.length).toBe(1);
    });
  });

  // ── Unknown status + malformed payload tests ──────────────────────
  // Call handleStatusCallback directly since direct routes are blocked.

  describe('unknown status and malformed payloads', () => {
    test('unknown Twilio status returns 200 but does not record event', async () => {
      const session = createTestSession('conv-unknown-1', 'CA_unknown_1');
      const params = {
        CallSid: 'CA_unknown_1',
        CallStatus: 'some-future-status',
        Timestamp: 'T1',
      };

      const res = await handleStatusCallback(makeStatusRequest(params));
      expect(res.status).toBe(200);

      const events = getCallEvents(session.id);
      expect(events.length).toBe(0);
    });

    test('missing CallSid returns 200 (graceful handling)', async () => {
      const res = await handleStatusCallback(makeStatusRequest({ CallStatus: 'completed' }));
      expect(res.status).toBe(200);
    });

    test('missing CallStatus returns 200 (graceful handling)', async () => {
      const res = await handleStatusCallback(makeStatusRequest({ CallSid: 'CA_no_status' }));
      expect(res.status).toBe(200);
    });

    test('CallSid not matching any session returns 200 without error', async () => {
      const params = {
        CallSid: 'CA_nonexistent_session',
        CallStatus: 'completed',
        Timestamp: 'T1',
      };

      const res = await handleStatusCallback(makeStatusRequest(params));
      expect(res.status).toBe(200);
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

  describe('buildWelcomeGreeting', () => {
    test('builds a contextual opener from task text', () => {
      const greeting = buildWelcomeGreeting('check store hours for tomorrow');
      expect(greeting).toBe('Hello, I am calling about check store hours for tomorrow. Is now a good time to talk?');
    });

    test('ignores appended Context block when building opener', () => {
      const greeting = buildWelcomeGreeting('check store hours\n\nContext: Caller asked by email');
      expect(greeting).toBe('Hello, I am calling about check store hours. Is now a good time to talk?');
      expect(greeting).not.toContain('Context:');
    });

    test('uses configured greeting override when provided', () => {
      const greeting = buildWelcomeGreeting('check store hours', 'Custom hello');
      expect(greeting).toBe('Custom hello');
    });
  });

  // ── TwiML relay URL generation ──────────────────────────────────────
  // Call handleVoiceWebhook directly since direct routes are blocked.

  describe('voice webhook TwiML relay URL', () => {
    test('TwiML uses explicit wssBaseUrl when set', async () => {
      mockWssBaseUrl = 'wss://explicit-ws.example.com';

      const session = createTestSession('conv-twiml-1', 'CA_twiml_1');
      const req = makeVoiceRequest(session.id, { CallSid: 'CA_twiml_1' });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain('wss://explicit-ws.example.com/v1/calls/relay');
    });

    test('TwiML falls back to webhookBaseUrl when wssBaseUrl is empty', async () => {
      mockWssBaseUrl = '';
      mockWebhookBaseUrl = 'https://gateway.example.com';

      const session = createTestSession('conv-twiml-2', 'CA_twiml_2');
      const req = makeVoiceRequest(session.id, { CallSid: 'CA_twiml_2' });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain('wss://gateway.example.com/v1/calls/relay');
    });

    test('TwiML welcome greeting is task-aware by default', async () => {
      const session = createTestSession(
        'conv-twiml-3',
        'CA_twiml_3',
        'confirm appointment time\n\nContext: Prior email thread',
      );
      const req = makeVoiceRequest(session.id, { CallSid: 'CA_twiml_3' });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain(
        'welcomeGreeting="Hello, I am calling about confirm appointment time. Is now a good time to talk?"',
      );
      expect(twiml).not.toContain('Hello, how can I help you today?');
    });
  });

  // ── Handler-level idempotency concurrency tests ─────────────────
  // Call handleStatusCallback directly since direct routes are blocked.

  describe('handler-level idempotency concurrency', () => {
    test('two concurrent identical status callbacks produce exactly one event', async () => {
      const session = createTestSession('conv-conc-1', 'CA_conc_1');
      const params = {
        CallSid: 'CA_conc_1',
        CallStatus: 'in-progress',
        Timestamp: '2025-01-20T10:00:00Z',
      };

      // Fire two identical callbacks concurrently
      const [res1, res2] = await Promise.all([
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
      ]);

      // Both should return 200 (one processes, one is deduplicated)
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Only one event should be recorded despite two concurrent requests
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);
    });

    test('three concurrent identical status callbacks still produce exactly one event', async () => {
      const session = createTestSession('conv-conc-2', 'CA_conc_2');
      const params = {
        CallSid: 'CA_conc_2',
        CallStatus: 'completed',
        Timestamp: '2025-01-20T11:00:00Z',
      };

      // Fire three identical callbacks concurrently
      const [res1, res2, res3] = await Promise.all([
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res3.status).toBe(200);

      const events = getCallEvents(session.id);
      const endedEvents = events.filter(e => e.eventType === 'call_ended');
      expect(endedEvents.length).toBe(1);
    });

    test('processing failure releases claim and allows successful retry', async () => {
      const session = createTestSession('conv-conc-3', 'CA_conc_3');
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

      // Call handleStatusCallback directly so we can catch the re-thrown error
      const directReq = makeStatusRequest(params);

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

      // Retry — should succeed because the catch block released the claim
      const retryRes = await handleStatusCallback(makeStatusRequest(params));
      expect(retryRes.status).toBe(200);

      // Now exactly one event should exist from the successful retry
      const eventsAfterRetry = getCallEvents(session.id);
      const connectedEvents = eventsAfterRetry.filter(e => e.eventType === 'call_connected');
      expect(connectedEvents.length).toBe(1);
    });

    test('permanently claimed callback cannot be retried', async () => {
      const session = createTestSession('conv-conc-4', 'CA_conc_4');
      const params = {
        CallSid: 'CA_conc_4',
        CallStatus: 'completed',
        Timestamp: '2025-01-20T13:00:00Z',
      };

      // First request processes successfully and finalizes the claim
      const res1 = await handleStatusCallback(makeStatusRequest(params));
      expect(res1.status).toBe(200);

      const events1 = getCallEvents(session.id);
      expect(events1.filter(e => e.eventType === 'call_ended').length).toBe(1);

      // Second request (retry) — should be deduplicated, no new events
      const res2 = await handleStatusCallback(makeStatusRequest(params));
      expect(res2.status).toBe(200);

      const events2 = getCallEvents(session.id);
      expect(events2.filter(e => e.eventType === 'call_ended').length).toBe(1);
    });
  });
});
