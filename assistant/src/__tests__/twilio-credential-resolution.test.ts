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
mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (key: string) => secureStore.get(key),
  setSecureKey: (key: string, value: string) => { secureStore.set(key, value); return true; },
  deleteSecureKey: (key: string) => secureStore.delete(key),
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
