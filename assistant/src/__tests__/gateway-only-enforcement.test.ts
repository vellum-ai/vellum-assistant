/**
 * Tests for gateway-only ingress enforcement in the runtime HTTP server.
 *
 * Verifies:
 * - Direct Twilio webhook routes return 410
 * - Internal forwarding routes (gateway→runtime) still work
 * - Relay WebSocket upgrade blocked for non-private-network origins (isPrivateNetworkOrigin)
 * - Relay WebSocket upgrade allowed from private network peers/origins
 * - Startup warning when RUNTIME_HTTP_HOST is not loopback
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'gw-only-enforcement-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

const logMessages: { level: string; msg: string; args?: unknown }[] = [];

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (prop === 'child') return () => new Proxy({} as Record<string, unknown>, {
        get: () => () => {},
      });
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string') {
          logMessages.push({ level: prop, msg: args[0] });
        } else if (typeof args[1] === 'string') {
          logMessages.push({ level: prop, msg: args[1], args: args[0] });
        }
      };
    },
  }),
}));

mock.module('../config/loader.js', () => ({
  loadConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: {
      enabled: true,
      provider: 'twilio',
      webhookBaseUrl: 'https://test.example.com',
      maxDurationSeconds: 3600,
      userConsultTimeoutSeconds: 120,
      disclosure: { enabled: false, text: '' },
      safety: { denyCategories: [] },
    },
    ingress: {
      publicBaseUrl: 'https://test.example.com',
    },
  }),
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    ingress: {
      publicBaseUrl: 'https://test.example.com',
    },
  }),
  invalidateConfigCache: () => {},
}));

// Mock Twilio provider
mock.module('../calls/twilio-provider.js', () => ({
  TwilioConversationRelayProvider: class {
    static getAuthToken() { return 'mock-auth-token'; }
    static verifyWebhookSignature() { return true; }
    async initiateCall() { return { callSid: 'CA_mock_sid' }; }
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

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: () => null,
  setSecureKey: () => true,
  deleteSecureKey: () => {},
}));

mock.module('../inbound/public-ingress-urls.js', () => ({
  getPublicBaseUrl: () => 'https://test.example.com',
  getTwilioRelayUrl: () => 'wss://test.example.com/webhooks/twilio/relay',
  getTwilioVoiceWebhookUrl: (_cfg: unknown, id: string) => `https://test.example.com/webhooks/twilio/voice?callSessionId=${id}`,
  getTwilioStatusCallbackUrl: () => 'https://test.example.com/webhooks/twilio/status',
  getTwilioConnectActionUrl: () => 'https://test.example.com/webhooks/twilio/connect-action',
  getOAuthCallbackUrl: () => 'https://test.example.com/webhooks/oauth/callback',
}));

// Mock the oauth callback registry
mock.module('../security/oauth-callback-registry.js', () => ({
  consumeCallback: () => true,
  consumeCallbackError: () => true,
}));

import { RuntimeHttpServer, isPrivateAddress } from '../runtime/http-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-bearer-token-gw';
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };

function makeFormBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateway-only ingress enforcement', () => {
  let server: RuntimeHttpServer;
  let port: number;

  beforeEach(async () => {
    logMessages.length = 0;
    server = new RuntimeHttpServer({
      port: 0,
      hostname: '127.0.0.1',
      bearerToken: TEST_TOKEN,
    });
    await server.start();
    port = server.actualPort;
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Direct Twilio webhook routes blocked in gateway_only mode ──────

  describe('direct webhook routes are blocked', () => {

    test('POST /webhooks/twilio/voice returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123', AccountSid: 'AC_test' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
      expect(body.error).toContain('Direct webhook access disabled');
    });

    test('POST /webhooks/twilio/status returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123', CallStatus: 'completed' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
    });

    test('POST /webhooks/twilio/connect-action returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/connect-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
    });

    test('POST /v1/calls/twilio/voice-webhook returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/twilio/voice-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
    });

    test('POST /v1/calls/twilio/status returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/twilio/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123', CallStatus: 'completed' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
    });
  });

  // ── Internal forwarding routes still work ─────

  describe('internal forwarding routes are not blocked', () => {

    test('POST /v1/internal/twilio/voice-webhook is NOT blocked', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/internal/twilio/voice-webhook`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: { CallSid: 'CA123', AccountSid: 'AC_test' },
          originalUrl: `http://127.0.0.1:${port}/v1/internal/twilio/voice-webhook?callSessionId=sess-123`,
        }),
      });
      // Should NOT be 410 — it may 404 or 400 because the call session
      // doesn't exist, but the gateway-only guard should NOT block it.
      expect(res.status).not.toBe(410);
    });

    test('POST /v1/internal/twilio/status is NOT blocked', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/internal/twilio/status`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: { CallSid: 'CA123', CallStatus: 'completed' },
        }),
      });
      expect(res.status).not.toBe(410);
    });

    test('POST /v1/internal/twilio/connect-action is NOT blocked', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/internal/twilio/connect-action`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          params: { CallSid: 'CA123' },
        }),
      });
      expect(res.status).not.toBe(410);
    });

    test('POST /v1/internal/oauth/callback is NOT blocked', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/internal/oauth/callback`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: 'test-state',
          code: 'test-code',
        }),
      });
      // Should succeed or return a non-410 status
      expect(res.status).not.toBe(410);
    });
  });

  // ── Relay WebSocket upgrade ───────────────────

  describe('relay WebSocket upgrade', () => {

    test('blocks non-private-network origin', async () => {
      // The peer address (127.0.0.1) passes the private network check,
      // but the external Origin header triggers the secondary defense-in-depth block.
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Origin': 'https://external.example.com',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
      expect(body.error).toContain('Direct relay access disabled');
    });

    test('allows request with no origin header (private network peer)', async () => {
      // Without an origin header, isPrivateNetworkOrigin returns true.
      // The peer address (127.0.0.1) passes the private network peer check.
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      // Should NOT be 403 — WebSocket upgrade may or may not succeed
      // depending on test environment, but the gateway guard should pass.
      expect(res.status).not.toBe(403);
    });

    test('allows localhost origin from loopback peer', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Origin': 'http://127.0.0.1:3000',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      // Should NOT be 403
      expect(res.status).not.toBe(403);
    });
  });

  // ── isPrivateAddress unit tests ─────────────────────────────────────

  describe('isPrivateAddress', () => {
    // Loopback
    test.each([
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.255',
      '::1',
      '::ffff:127.0.0.1',
    ])('accepts loopback address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // RFC 1918 private ranges
    test.each([
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.168.1.100',
    ])('accepts RFC 1918 private address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // Link-local
    test.each([
      '169.254.0.1',
      '169.254.255.255',
    ])('accepts link-local address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // IPv6 unique local (fc00::/7)
    test.each([
      'fc00::1',
      'fd12:3456:789a::1',
      'fdff::1',
    ])('accepts IPv6 unique local address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // IPv6 link-local (fe80::/10)
    test.each([
      'fe80::1',
      'fe80::abcd:1234',
    ])('accepts IPv6 link-local address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // IPv4-mapped IPv6 private addresses
    test.each([
      '::ffff:10.0.0.1',
      '::ffff:172.16.0.1',
      '::ffff:192.168.1.1',
      '::ffff:169.254.0.1',
    ])('accepts IPv4-mapped IPv6 private address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // Public addresses — should be rejected
    test.each([
      '8.8.8.8',
      '1.1.1.1',
      '203.0.113.1',
      '172.32.0.1',
      '172.15.255.255',
      '11.0.0.1',
      '192.169.0.1',
      '::ffff:8.8.8.8',
      '2001:db8::1',
    ])('rejects public address %s', (addr) => {
      expect(isPrivateAddress(addr)).toBe(false);
    });
  });

  // ── Startup warning for non-loopback host ──────────────────────────

  describe('startup guard — non-loopback host', () => {
    test('server starts successfully when hostname is not loopback', async () => {
      const warnServer = new RuntimeHttpServer({
        port: 0,
        hostname: '0.0.0.0',
        bearerToken: TEST_TOKEN,
      });
      await warnServer.start();
      expect(warnServer.actualPort).toBeGreaterThan(0);
      await warnServer.stop();
    });

    test('server starts successfully when hostname is loopback', async () => {
      const loopbackServer = new RuntimeHttpServer({
        port: 0,
        hostname: '127.0.0.1',
        bearerToken: TEST_TOKEN,
      });
      await loopbackServer.start();
      expect(loopbackServer.actualPort).toBeGreaterThan(0);
      await loopbackServer.stop();
    });
  });
});
