/**
 * Tests for Twilio credentials endpoint server-side credential resolution.
 *
 * Verifies that POST /v1/integrations/twilio/credentials can resolve
 * credentials from secure storage when body omits them, and that explicit
 * body values take precedence.
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'twilio-cred-test-')));

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
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  getWorkspaceDir: () => testDir,
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
}));

mock.module('../config/env.js', () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => 'http://localhost:8080',
}));

// Mock secure keys storage
const secureStore = new Map<string, string>();
const setSecureKeyCalls: Array<{ key: string; value: string }> = [];
const deleteSecureKeyCalls: Array<{ key: string }> = [];
/** Keys for which setSecureKey should return false (simulate storage failure). */
const setSecureKeyFailures = new Set<string>();
mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (key: string) => secureStore.get(key),
  setSecureKey: (key: string, value: string) => {
    setSecureKeyCalls.push({ key, value });
    if (setSecureKeyFailures.has(key)) return false;
    secureStore.set(key, value);
    return true;
  },
  deleteSecureKey: (key: string) => {
    deleteSecureKeyCalls.push({ key });
    secureStore.delete(key);
  },
}));

// Track metadata upserts
const metadataUpserts: Array<{ service: string; field: string }> = [];
mock.module('../tools/credentials/metadata-store.js', () => ({
  upsertCredentialMetadata: (service: string, field: string) => {
    metadataUpserts.push({ service, field });
  },
  deleteCredentialMetadata: () => {},
}));

// Mock the Twilio REST helpers
mock.module('../calls/twilio-rest.js', () => ({
  hasTwilioCredentials: () => secureStore.has('credential:twilio:account_sid') && secureStore.has('credential:twilio:auth_token'),
  listIncomingPhoneNumbers: async () => [],
}));

mock.module('../config/loader.js', () => ({
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getConfig: () => ({ memory: { enabled: false } }),
}));

mock.module('../daemon/handlers/config-channels.js', () => ({
  getReadinessService: () => ({ getReadiness: async () => [] }),
}));

mock.module('../daemon/handlers/config-ingress.js', () => ({
  syncTwilioWebhooks: async () => ({ warning: undefined }),
}));

// Track fetch calls to Twilio API
let lastFetchUrl = '';
let fetchShouldSucceed = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('api.twilio.com')) {
    lastFetchUrl = url;
    if (fetchShouldSucceed) {
      return new Response(JSON.stringify({ sid: 'ACtest', status: 'active' }), { status: 200 });
    }
    return new Response('Unauthorized', { status: 401 });
  }
  return originalFetch(input, init);
};

const { handleSetTwilioCredentials } = await import('../runtime/routes/twilio-routes.js');

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  secureStore.clear();
  setSecureKeyCalls.length = 0;
  deleteSecureKeyCalls.length = 0;
  setSecureKeyFailures.clear();
  metadataUpserts.length = 0;
  lastFetchUrl = '';
  fetchShouldSucceed = true;
});

// Ensure metadata directory exists
mkdirSync(join(testDir, 'credentials'), { recursive: true });
writeFileSync(join(testDir, 'credentials', 'metadata.json'), JSON.stringify({ version: 2, credentials: {} }));

describe('Twilio credentials endpoint server-side resolution', () => {
  test('explicit body credentials are accepted and validated', async () => {
    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountSid: 'ACexplicit', authToken: 'token123' }),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; hasCredentials: boolean };

    expect(data.success).toBe(true);
    expect(data.hasCredentials).toBe(true);
    expect(lastFetchUrl).toContain('ACexplicit');
    expect(secureStore.get('credential:twilio:account_sid')).toBe('ACexplicit');
    expect(secureStore.get('credential:twilio:auth_token')).toBe('token123');
  });

  test('empty body resolves credentials from secure storage', async () => {
    secureStore.set('credential:twilio:account_sid', 'ACstored');
    secureStore.set('credential:twilio:auth_token', 'storedToken');

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; hasCredentials: boolean };

    expect(data.success).toBe(true);
    expect(data.hasCredentials).toBe(true);
    expect(lastFetchUrl).toContain('ACstored');
  });

  test('empty body with missing stored credentials fails with clear error', async () => {
    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; error: string };

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('accountSid');
    expect(data.error).toContain('authToken');
    expect(data.error).toContain('credential_store');
  });

  test('partial stored credentials (only account_sid) fails cleanly', async () => {
    secureStore.set('credential:twilio:account_sid', 'ACpartial');

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; error: string };

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('authToken');
    expect(data.error).not.toContain('accountSid');
  });

  test('explicit body values take precedence over stored values', async () => {
    secureStore.set('credential:twilio:account_sid', 'ACstored');
    secureStore.set('credential:twilio:auth_token', 'storedToken');

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountSid: 'ACoverride', authToken: 'overrideToken' }),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean };

    expect(data.success).toBe(true);
    expect(lastFetchUrl).toContain('ACoverride');
    expect(secureStore.get('credential:twilio:account_sid')).toBe('ACoverride');
  });

  test('empty body does not rewrite credentials to secure storage', async () => {
    secureStore.set('credential:twilio:account_sid', 'ACstored');
    secureStore.set('credential:twilio:auth_token', 'storedToken');
    // Clear the tracking arrays after seeding the store so we only see calls from the handler
    setSecureKeyCalls.length = 0;
    metadataUpserts.length = 0;

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; hasCredentials: boolean };

    expect(data.success).toBe(true);
    expect(data.hasCredentials).toBe(true);
    // The handler should NOT have called setSecureKey when credentials came from storage
    expect(setSecureKeyCalls).toEqual([]);
    // No metadata upserts should have been made either
    expect(metadataUpserts).toEqual([]);
  });

  test('partial body (authToken only) rollback does not delete stored account_sid', async () => {
    // Pre-seed account_sid in storage (simulating a previously stored credential)
    secureStore.set('credential:twilio:account_sid', 'ACprevious');
    secureStore.set('credential:twilio:auth_token', 'oldToken');
    // Clear tracking arrays after seeding
    setSecureKeyCalls.length = 0;
    deleteSecureKeyCalls.length = 0;
    metadataUpserts.length = 0;

    // Make setSecureKey fail for auth_token to trigger rollback
    setSecureKeyFailures.add('credential:twilio:auth_token');

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: 'newRotatedToken' }),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; error: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain('Auth Token');

    // The stored account_sid should NOT have been deleted because it was not provided in the body
    expect(secureStore.get('credential:twilio:account_sid')).toBe('ACprevious');
    expect(deleteSecureKeyCalls.filter((c) => c.key === 'credential:twilio:account_sid')).toEqual([]);
  });

  test('partial body (accountSid only) persists only account_sid', async () => {
    // Pre-seed auth_token in storage
    secureStore.set('credential:twilio:auth_token', 'existingToken');
    setSecureKeyCalls.length = 0;
    metadataUpserts.length = 0;

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountSid: 'ACnew' }),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; hasCredentials: boolean };

    expect(data.success).toBe(true);
    expect(data.hasCredentials).toBe(true);

    // Only account_sid should have been written, not auth_token
    expect(setSecureKeyCalls).toEqual([
      { key: 'credential:twilio:account_sid', value: 'ACnew' },
    ]);
    expect(metadataUpserts).toEqual([
      { service: 'twilio', field: 'account_sid' },
    ]);
  });

  test('invalid credentials from Twilio API return error', async () => {
    fetchShouldSucceed = false;

    const req = new Request('http://localhost/v1/integrations/twilio/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountSid: 'ACbad', authToken: 'badToken' }),
    });

    const res = await handleSetTwilioCredentials(req);
    const data = await res.json() as { success: boolean; error: string };

    expect(data.success).toBe(false);
    expect(data.error).toContain('validation failed');
  });
});
