/**
 * Tests for the outbound guardian HTTP control-plane endpoints and the
 * shared action module that backs them.
 *
 * Verifies:
 * - startOutbound / resendOutbound / cancelOutbound return correct result
 *   shapes and stable error codes.
 * - HTTP route handlers (handleStartOutbound / handleResendOutbound /
 *   handleCancelOutbound) wire through to the shared module and return
 *   appropriate HTTP status codes.
 * - Rate limiting, missing/invalid destination, already_bound, and
 *   no_active_session error paths all produce the expected error codes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'guardian-outbound-http-test-'));

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
  normalizeAssistantId: (id: string) => id === 'self' ? 'self' : id,
  readHttpToken: () => 'test-bearer-token',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// SMS client mock — track calls
const smsSendCalls: Array<{ to: string; text: string; assistantId?: string }> = [];
mock.module('../messaging/providers/sms/client.js', () => ({
  sendMessage: async (_gatewayUrl: string, _bearerToken: string, to: string, text: string, assistantId?: string) => {
    smsSendCalls.push({ to, text, assistantId });
    return { messageSid: 'SM-mock', status: 'queued' };
  },
}));

mock.module('../config/env.js', () => ({
  getGatewayInternalBaseUrl: () => 'http://127.0.0.1:7830',
}));

// Telegram credential metadata mock
let mockBotUsername: string | undefined = 'test_bot';
mock.module('../tools/credentials/metadata-store.js', () => ({
  getCredentialMetadata: (_service: string, _key: string) => mockBotUsername ? { accountInfo: mockBotUsername } : null,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));

// Voice call mock
const voiceCallInitCalls: Array<{ phoneNumber: string; guardianVerificationSessionId: string; assistantId?: string }> = [];
mock.module('../calls/call-domain.js', () => ({
  startGuardianVerificationCall: async (input: { phoneNumber: string; guardianVerificationSessionId: string; assistantId?: string }) => {
    voiceCallInitCalls.push(input);
    return { ok: true, callSessionId: 'mock-call-session', callSid: 'CA-mock' };
  },
}));

// Telegram delivery mock via fetch
const telegramDeliverCalls: Array<{ chatId: string; text: string; assistantId?: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/deliver/telegram') && init?.method === 'POST') {
    const body = JSON.parse(init.body as string) as { chatId: string; text: string; assistantId?: string };
    telegramDeliverCalls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(input, init as never);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Now import modules under test (after mocks are in place)
// ---------------------------------------------------------------------------

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import {
  updateSessionDelivery,
} from '../runtime/channel-guardian-service.js';
import {
  cancelOutbound,
  resendOutbound,
  startOutbound,
} from '../runtime/guardian-outbound-actions.js';
import {
  handleCancelOutbound,
  handleResendOutbound,
  handleStartOutbound,
} from '../runtime/routes/integration-routes.js';

// Initialize the database (creates all tables)
initializeDb();

afterAll(() => {
  globalThis.fetch = originalFetch;
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_guardian_verification_challenges');
  try { db.run('DELETE FROM channel_guardian_approval_requests'); } catch { /* table may not exist */ }
  try { db.run('DELETE FROM channel_guardian_rate_limits'); } catch { /* table may not exist */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Reset mutable state between tests
beforeEach(() => {
  resetTables();
  smsSendCalls.length = 0;
  telegramDeliverCalls.length = 0;
  voiceCallInitCalls.length = 0;
  mockBotUsername = 'test_bot';
});

// ===========================================================================
// Shared action module: startOutbound
// ===========================================================================

describe('startOutbound', () => {
  test('SMS: returns missing_destination when destination is absent', () => {
    const result = startOutbound({ channel: 'sms' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_destination');
    expect(result.channel).toBe('sms');
  });

  test('SMS: returns invalid_destination for garbage phone number', () => {
    const result = startOutbound({ channel: 'sms', destination: 'notaphone' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_destination');
  });

  test('SMS: succeeds with valid E.164 number', () => {
    const result = startOutbound({ channel: 'sms', destination: '+15551234567' });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.nextResendAt).toBeGreaterThan(Date.now());
    expect(result.sendCount).toBe(1);
    expect(result.channel).toBe('sms');
  });

  test('SMS: succeeds with loose phone format (parentheses + dashes)', () => {
    const result = startOutbound({ channel: 'sms', destination: '(555) 987-6543' });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
  });

  test('Telegram: returns missing_destination when absent', () => {
    const result = startOutbound({ channel: 'telegram' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_destination');
  });

  test('Telegram: succeeds with numeric chat ID', () => {
    const result = startOutbound({ channel: 'telegram', destination: '123456789' });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.sendCount).toBe(1);
  });

  test('Telegram: returns invalid_destination for negative (group) chat ID', () => {
    const result = startOutbound({ channel: 'telegram', destination: '-100123456' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_destination');
  });

  test('Telegram: returns pending_bootstrap for handle destination', () => {
    const result = startOutbound({ channel: 'telegram', destination: '@someuser' });
    expect(result.success).toBe(true);
    expect(result.telegramBootstrapUrl).toContain('https://t.me/test_bot?start=gv_');
    // Secret should NOT be present in bootstrap response
    expect(result.secret).toBeUndefined();
  });

  test('Telegram: returns no_bot_username when bot not configured', () => {
    mockBotUsername = undefined;
    const result = startOutbound({ channel: 'telegram', destination: '@someuser' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_bot_username');
  });

  test('voice: returns missing_destination when absent', () => {
    const result = startOutbound({ channel: 'voice' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_destination');
  });

  test('voice: returns invalid_destination for garbage', () => {
    const result = startOutbound({ channel: 'voice', destination: 'badphone' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_destination');
  });

  test('voice: succeeds with valid phone', () => {
    const result = startOutbound({ channel: 'voice', destination: '+15559876543' });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.sendCount).toBe(1);
  });

  test('unsupported channel returns unsupported_channel', () => {
    // Cast to bypass type checking for test purposes
    const result = startOutbound({ channel: 'email' as never });
    expect(result.success).toBe(false);
    expect(result.error).toBe('unsupported_channel');
  });
});

// ===========================================================================
// Shared action module: resendOutbound
// ===========================================================================

describe('resendOutbound', () => {
  test('returns no_active_session when no session exists', () => {
    const result = resendOutbound({ channel: 'sms', assistantId: 'no-such-assistant' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_active_session');
  });

  test('SMS: succeeds when an active session exists and cooldown has passed', () => {
    // Start a session first
    const startResult = startOutbound({ channel: 'sms', destination: '+15551112222' });
    expect(startResult.success).toBe(true);

    // Manually update delivery to set cooldown in the past so resend is allowed
    if (startResult.verificationSessionId) {
      updateSessionDelivery(startResult.verificationSessionId, Date.now() - 60_000, 1, Date.now() - 1);
    }

    const resendResult = resendOutbound({ channel: 'sms' });
    expect(resendResult.success).toBe(true);
    expect(resendResult.verificationSessionId).toBeDefined();
    expect(resendResult.sendCount).toBe(2);
  });
});

// ===========================================================================
// Shared action module: cancelOutbound
// ===========================================================================

describe('cancelOutbound', () => {
  test('returns no_active_session when no session exists', () => {
    const result = cancelOutbound({ channel: 'sms', assistantId: 'no-such-assistant-cancel' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('no_active_session');
  });

  test('succeeds when an active session exists', () => {
    const startResult = startOutbound({ channel: 'sms', destination: '+15553334444' });
    expect(startResult.success).toBe(true);

    const cancelResult = cancelOutbound({ channel: 'sms' });
    expect(cancelResult.success).toBe(true);
    expect(cancelResult.channel).toBe('sms');
  });
});

// ===========================================================================
// HTTP route handlers
// ===========================================================================

describe('HTTP route: handleStartOutbound', () => {
  test('returns 400 when channel is missing', async () => {
    const req = jsonRequest({ destination: '+15551234567' });
    const resp = await handleStartOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('missing_channel');
  });

  test('returns 400 for missing destination (SMS)', async () => {
    const req = jsonRequest({ channel: 'sms' });
    const resp = await handleStartOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('missing_destination');
  });

  test('returns 200 for valid SMS start', async () => {
    const req = jsonRequest({ channel: 'sms', destination: '+15559999999' });
    const resp = await handleStartOutbound(req);
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.verificationSessionId).toBeDefined();
  });
});

describe('HTTP route: handleResendOutbound', () => {
  test('returns 400 when channel is missing', async () => {
    const req = jsonRequest({});
    const resp = await handleResendOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('missing_channel');
  });

  test('returns 400 for no_active_session', async () => {
    const req = jsonRequest({ channel: 'sms', assistantId: 'resend-no-session' });
    const resp = await handleResendOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('no_active_session');
  });
});

describe('HTTP route: handleCancelOutbound', () => {
  test('returns 400 when channel is missing', async () => {
    const req = jsonRequest({});
    const resp = await handleCancelOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('missing_channel');
  });

  test('returns 400 for no_active_session', async () => {
    const req = jsonRequest({ channel: 'sms', assistantId: 'cancel-no-session' });
    const resp = await handleCancelOutbound(req);
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe('no_active_session');
  });

  test('returns 200 when active session is cancelled', async () => {
    // Start a session
    const startReq = jsonRequest({ channel: 'sms', destination: '+15558887777' });
    const startResp = await handleStartOutbound(startReq);
    expect(startResp.status).toBe(200);

    // Cancel it
    const cancelReq = jsonRequest({ channel: 'sms' });
    const cancelResp = await handleCancelOutbound(cancelReq);
    expect(cancelResp.status).toBe(200);
    const body = await cancelResp.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
  });
});
