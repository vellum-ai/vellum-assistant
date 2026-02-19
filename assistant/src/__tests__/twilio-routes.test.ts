/**
 * Integration tests for Twilio webhook route handlers.
 *
 * Tests:
 * - Signature valid/invalid/missing header
 * - Fail-closed behavior when auth token is not configured
 * - TWILIO_WEBHOOK_VALIDATION_DISABLED env flag bypass
 * - Duplicate callback replay (idempotency)
 * - Unknown status and malformed payload handling
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
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
    if (account === 'twilio_auth_token') return mockAuthToken;
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
        return getSecureKey('twilio_auth_token') ?? null;
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

mock.module('../calls/twilio-config.js', () => ({
  getTwilioConfig: () => ({
    accountSid: 'AC_test',
    authToken: 'test-auth-token-for-webhooks',
    phoneNumber: '+15550001111',
    webhookBaseUrl: 'https://test.example.com',
    wssBaseUrl: 'wss://test.example.com',
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import { RuntimeHttpServer } from '../runtime/http-server.js';
import {
  createCallSession,
  updateCallSession,
  getCallEvents,
} from '../calls/call-store.js';

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
    delete process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function startServer(): Promise<void> {
    port = 20000 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({ port, bearerToken: TEST_TOKEN });
    await server.start();
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
});
