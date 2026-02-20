/**
 * Tests for gateway-only ingress mode enforcement in the runtime HTTP server.
 *
 * Verifies:
 * - Direct Twilio webhook routes return 410 in gateway_only mode
 * - Internal forwarding routes (gateway→runtime) still work in gateway_only mode
 * - Relay WebSocket upgrade blocked for non-private-network origins in gateway_only mode
 * - Relay WebSocket upgrade allowed from private network peers in gateway_only mode
 * - All routes work normally in compat mode
 * - Startup warning when RUNTIME_HTTP_HOST is not loopback in gateway_only mode
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
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

// Configurable ingress mode — tests toggle this between 'gateway_only' and 'compat'
let mockIngressMode: 'gateway_only' | 'compat' = 'compat';

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
      mode: mockIngressMode,
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
      mode: mockIngressMode,
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
    port = 17800 + Math.floor(Math.random() * 1000);
    server = new RuntimeHttpServer({
      port,
      hostname: '127.0.0.1',
      bearerToken: TEST_TOKEN,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Direct Twilio webhook routes blocked in gateway_only mode ──────

  describe('gateway_only mode — direct webhook routes', () => {
    beforeEach(() => { mockIngressMode = 'gateway_only'; });
    afterEach(() => { mockIngressMode = 'compat'; });

    test('POST /webhooks/twilio/voice returns 410', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: makeFormBody({ CallSid: 'CA123', AccountSid: 'AC_test' }),
      });
      expect(res.status).toBe(410);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('GATEWAY_ONLY');
      expect(body.error).toContain('gateway-only mode');
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

  // ── Internal forwarding routes still work in gateway_only mode ─────

  describe('gateway_only mode — internal forwarding routes', () => {
    beforeEach(() => { mockIngressMode = 'gateway_only'; });
    afterEach(() => { mockIngressMode = 'compat'; });

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

  // ── Relay WebSocket upgrade in gateway_only mode ───────────────────

  describe('gateway_only mode — relay WebSocket upgrade', () => {
    beforeEach(() => { mockIngressMode = 'gateway_only'; });
    afterEach(() => { mockIngressMode = 'compat'; });

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
      expect(body.error).toContain('gateway-only mode');
    });

    test('allows request with no origin header (private network peer)', async () => {
      // Without an origin header, isLoopbackOrigin returns true.
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

  // ── Compat mode — everything works as before ───────────────────────

  describe('compat mode — no enforcement', () => {
    beforeEach(() => { mockIngressMode = 'compat'; });

    test('POST /webhooks/twilio/voice is NOT blocked', async () => {
      // In compat mode, disable webhook validation to focus on the ingress check
      const savedDisable = process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = 'true';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/voice?callSessionId=test-compat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: makeFormBody({ CallSid: 'CA_compat', AccountSid: 'AC_test' }),
        });
        // Should NOT be 410 (gateway-only)
        expect(res.status).not.toBe(410);
      } finally {
        if (savedDisable !== undefined) {
          process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = savedDisable;
        } else {
          delete process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
        }
      }
    });

    test('POST /webhooks/twilio/status is NOT blocked', async () => {
      const savedDisable = process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
      process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = 'true';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/webhooks/twilio/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: makeFormBody({ CallSid: 'CA_compat', CallStatus: 'completed' }),
        });
        expect(res.status).not.toBe(410);
      } finally {
        if (savedDisable !== undefined) {
          process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED = savedDisable;
        } else {
          delete process.env.TWILIO_WEBHOOK_VALIDATION_DISABLED;
        }
      }
    });

    test('relay WebSocket upgrade is NOT blocked for external origin', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-compat`, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Origin': 'https://external.example.com',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      // In compat mode, the gateway-only guard should not activate
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

  describe('startup guard — non-loopback host warning', () => {
    test('logs warning when hostname is not loopback in gateway_only mode', async () => {
      mockIngressMode = 'gateway_only';
      logMessages.length = 0;

      const warnServer = new RuntimeHttpServer({
        port: port + 100,
        hostname: '0.0.0.0',
        bearerToken: TEST_TOKEN,
      });
      await warnServer.start();

      const infoMsg = logMessages.find(
        m => m.level === 'info' && m.msg.includes('gateway-only ingress mode'),
      );
      expect(infoMsg).toBeDefined();

      const warnMsg = logMessages.find(
        m => m.level === 'warn' && m.msg.includes('not bound to loopback'),
      );
      expect(warnMsg).toBeDefined();

      await warnServer.stop();
      mockIngressMode = 'compat';
    });

    test('does NOT log warning when hostname is loopback in gateway_only mode', async () => {
      mockIngressMode = 'gateway_only';
      logMessages.length = 0;

      // The main test server already uses 127.0.0.1, so restart with
      // a fresh server and capture logs
      const loopbackServer = new RuntimeHttpServer({
        port: port + 200,
        hostname: '127.0.0.1',
        bearerToken: TEST_TOKEN,
      });
      await loopbackServer.start();

      const infoMsg = logMessages.find(
        m => m.level === 'info' && m.msg.includes('gateway-only ingress mode'),
      );
      expect(infoMsg).toBeDefined();

      const warnMsg = logMessages.find(
        m => m.level === 'warn' && m.msg.includes('not bound to loopback'),
      );
      expect(warnMsg).toBeUndefined();

      await loopbackServer.stop();
      mockIngressMode = 'compat';
    });
  });
});
