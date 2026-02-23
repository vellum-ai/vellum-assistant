import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'handlers-twilio-cfg-test-'));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({ ...rawConfigStore }),
  loadConfig: () => ({ ...rawConfigStore }),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Provide a thin mock of public-ingress-urls that computes real-looking
// webhook URLs from the raw config store so that both getTwilioConfig()
// and the syncTwilioWebhooks() helper used by ingress tests work correctly.
mock.module('../inbound/public-ingress-urls.js', () => {
  function getBase(config: Record<string, unknown>): string {
    const ingress = (config?.ingress ?? {}) as Record<string, unknown>;
    const url = (ingress.publicBaseUrl as string) ?? '';
    if (!url) throw new Error('No public ingress URL configured');
    return url;
  }
  return {
    getPublicBaseUrl: (config: Record<string, unknown>) => getBase(config),
    getTwilioRelayUrl: (config: Record<string, unknown>) => {
      const base = getBase(config);
      return base.replace(/^http(s?)/, 'ws$1') + '/webhooks/twilio/relay';
    },
    getTwilioVoiceWebhookUrl: (config: Record<string, unknown>) => getBase(config) + '/webhooks/twilio/voice',
    getTwilioStatusCallbackUrl: (config: Record<string, unknown>) => getBase(config) + '/webhooks/twilio/status',
    getTwilioSmsWebhookUrl: (config: Record<string, unknown>) => getBase(config) + '/webhooks/twilio/sms',
  };
});

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  readHttpToken: () => undefined,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    isDebug: () => false,
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      isDebug: () => false,
    }),
  }),
}));

// Mock secure key storage
let secureKeyStore: Record<string, string> = {};
let setSecureKeyOverride: ((account: string, value: string) => boolean) | null = null;

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
    if (setSecureKeyOverride) return setSecureKeyOverride(account, value);
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKey: (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return true;
    }
    return false;
  },
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => 'encrypted',
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

// Mock credential metadata store
let credentialMetadataStore: Array<{ service: string; field: string; accountInfo?: string }> = [];
const deletedMetadata: Array<{ service: string; field: string }> = [];

mock.module('../tools/credentials/metadata-store.js', () => ({
  getCredentialMetadata: (service: string, field: string) =>
    credentialMetadataStore.find((m) => m.service === service && m.field === field) ?? undefined,
  upsertCredentialMetadata: (service: string, field: string, policy?: Record<string, unknown>) => {
    const existing = credentialMetadataStore.find((m) => m.service === service && m.field === field);
    if (existing) {
      if (policy?.accountInfo !== undefined) existing.accountInfo = policy.accountInfo as string;
      return existing;
    }
    const record = { service, field, accountInfo: policy?.accountInfo as string | undefined };
    credentialMetadataStore.push(record);
    return record;
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    deletedMetadata.push({ service, field });
    const idx = credentialMetadataStore.findIndex((m) => m.service === service && m.field === field);
    if (idx !== -1) {
      credentialMetadataStore.splice(idx, 1);
      return true;
    }
    return false;
  },
  listCredentialMetadata: () => credentialMetadataStore,
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

// Mock fetch for Twilio API validation
const originalFetch = globalThis.fetch;

import { handleTwilioConfig, handleIngressConfig } from '../daemon/handlers/config.js';
import { getTwilioConfig } from '../calls/twilio-config.js';
import type { HandlerContext } from '../daemon/handlers.js';
import type {
  TwilioConfigRequest,
  IngressConfigRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';
import { DebouncerMap } from '../util/debounce.js';

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuSessionMetadata: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => { sent.push(msg); },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => { throw new Error('not implemented'); },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe('Twilio config handler', () => {
  beforeEach(() => {
    rawConfigStore = {};
    secureKeyStore = {};
    setSecureKeyOverride = null;
    credentialMetadataStore = [];
    deletedMetadata.length = 0;
    globalThis.fetch = originalFetch;
  });

  // ── get ──────────────────────────────────────────────────────────────

  test('get action returns correct state when not configured', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean; phoneNumber?: string };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(false);
    expect(res.phoneNumber).toBeUndefined();
  });

  test('get action returns correct state when fully configured', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'auth_token_value';
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean; phoneNumber?: string };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(true);
    expect(res.phoneNumber).toBe('+15551234567');
  });

  // ── set_credentials ─────────────────────────────────────────────────

  test('set_credentials validates and stores credentials', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.twilio.com') && urlStr.includes('/Accounts/')) {
        return new Response(JSON.stringify({
          sid: 'AC1234567890abcdef1234567890abcdef',
          friendly_name: 'Test Account',
          status: 'active',
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC1234567890abcdef1234567890abcdef',
      authToken: 'test_auth_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(true);

    // Verify credentials were stored
    expect(secureKeyStore['credential:twilio:account_sid']).toBe('AC1234567890abcdef1234567890abcdef');
    expect(secureKeyStore['credential:twilio:auth_token']).toBe('test_auth_token');
    // Verify metadata was stored
    expect(credentialMetadataStore.find((m) => m.service === 'twilio' && m.field === 'account_sid')).toBeDefined();
    expect(credentialMetadataStore.find((m) => m.service === 'twilio' && m.field === 'auth_token')).toBeDefined();
  });

  test('set_credentials returns error when accountSid is missing', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      authToken: 'test_auth_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('accountSid and authToken are required');
  });

  test('set_credentials returns error when authToken is missing', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC1234567890abcdef1234567890abcdef',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('accountSid and authToken are required');
  });

  test('set_credentials returns error when Twilio API rejects credentials', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.twilio.com') && urlStr.includes('/Accounts/')) {
        return new Response(JSON.stringify({
          code: 20003,
          message: 'Authenticate',
        }), { status: 401 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC_invalid',
      authToken: 'bad_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Twilio API validation failed');

    // Verify credentials were NOT stored
    expect(secureKeyStore['credential:twilio:account_sid']).toBeUndefined();
    expect(secureKeyStore['credential:twilio:auth_token']).toBeUndefined();
  });

  test('set_credentials handles network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error: ECONNREFUSED');
    }) as unknown as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC1234567890abcdef1234567890abcdef',
      authToken: 'test_auth_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to validate Twilio credentials');
    expect(res.error).toContain('ECONNREFUSED');
  });

  test('set_credentials rolls back account_sid when auth_token storage fails', async () => {
    setSecureKeyOverride = (account: string, value: string) => {
      if (account === 'credential:twilio:auth_token') return false;
      secureKeyStore[account] = value;
      return true;
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.twilio.com') && urlStr.includes('/Accounts/')) {
        return new Response(JSON.stringify({ sid: 'AC123', status: 'active' }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC1234567890abcdef1234567890abcdef',
      authToken: 'test_auth_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to store Auth Token');

    // Account SID should have been rolled back
    expect(secureKeyStore['credential:twilio:account_sid']).toBeUndefined();
  });

  test('set_credentials fails when account_sid storage fails', async () => {
    setSecureKeyOverride = () => false;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.twilio.com') && urlStr.includes('/Accounts/')) {
        return new Response(JSON.stringify({ sid: 'AC123', status: 'active' }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'set_credentials',
      accountSid: 'AC1234567890abcdef1234567890abcdef',
      authToken: 'test_auth_token',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to store Account SID');
  });

  // ── clear_credentials ───────────────────────────────────────────────

  test('clear_credentials removes stored credentials but preserves phone number', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    secureKeyStore['credential:twilio:phone_number'] = '+15551234567';
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };
    credentialMetadataStore.push({ service: 'twilio', field: 'account_sid' });
    credentialMetadataStore.push({ service: 'twilio', field: 'auth_token' });

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'clear_credentials',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(false);

    // Verify auth credentials were cleaned up
    expect(secureKeyStore['credential:twilio:account_sid']).toBeUndefined();
    expect(secureKeyStore['credential:twilio:auth_token']).toBeUndefined();
    expect(deletedMetadata).toContainEqual({ service: 'twilio', field: 'account_sid' });
    expect(deletedMetadata).toContainEqual({ service: 'twilio', field: 'auth_token' });

    // Verify phone number is preserved in both stores
    expect(secureKeyStore['credential:twilio:phone_number']).toBe('+15551234567');
    expect((rawConfigStore.sms as Record<string, unknown>)?.phoneNumber).toBe('+15551234567');
  });

  test('clear_credentials is idempotent when no credentials exist', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'clear_credentials',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean };
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(false);
  });

  // ── Phone number resolution order ──────────────────────────────────

  test('getTwilioConfig resolves phone number from config when secure key also present', () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    secureKeyStore['credential:twilio:phone_number'] = '+15559999999';
    rawConfigStore = {
      sms: { phoneNumber: '+15551234567' },
      ingress: { enabled: true, publicBaseUrl: 'https://test.ngrok.io' },
    };

    // Clean env var to test config-only resolution
    const savedEnv = process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_PHONE_NUMBER;

    try {
      const config = getTwilioConfig();
      // Config value (+15551234567) should take priority over secure key (+15559999999)
      expect(config.phoneNumber).toBe('+15551234567');
    } finally {
      if (savedEnv !== undefined) process.env.TWILIO_PHONE_NUMBER = savedEnv;
    }
  });

  test('getTwilioConfig falls back to secure key when config has no phone number', () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    secureKeyStore['credential:twilio:phone_number'] = '+15559999999';
    rawConfigStore = {
      ingress: { enabled: true, publicBaseUrl: 'https://test.ngrok.io' },
    };

    const savedEnv = process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_PHONE_NUMBER;

    try {
      const config = getTwilioConfig();
      // Secure key should be used as fallback
      expect(config.phoneNumber).toBe('+15559999999');
    } finally {
      if (savedEnv !== undefined) process.env.TWILIO_PHONE_NUMBER = savedEnv;
    }
  });

  test('getTwilioConfig env var overrides both config and secure key', () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    secureKeyStore['credential:twilio:phone_number'] = '+15559999999';
    rawConfigStore = {
      sms: { phoneNumber: '+15551234567' },
      ingress: { enabled: true, publicBaseUrl: 'https://test.ngrok.io' },
    };

    const savedEnv = process.env.TWILIO_PHONE_NUMBER;
    process.env.TWILIO_PHONE_NUMBER = '+15550000000';

    try {
      const config = getTwilioConfig();
      // Env var should take highest priority
      expect(config.phoneNumber).toBe('+15550000000');
    } finally {
      if (savedEnv !== undefined) {
        process.env.TWILIO_PHONE_NUMBER = savedEnv;
      } else {
        delete process.env.TWILIO_PHONE_NUMBER;
      }
    }
  });

  // ── assign_number ───────────────────────────────────────────────────

  test('assign_number persists phone number to config', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15551234567',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15551234567');

    // Verify config was persisted
    expect((rawConfigStore.sms as Record<string, unknown>)?.phoneNumber).toBe('+15551234567');
  });

  test('assign_number returns error when phoneNumber is missing', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('phoneNumber is required');
  });

  // ── list_numbers ────────────────────────────────────────────────────

  test('list_numbers returns available numbers', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({
          incoming_phone_numbers: [
            {
              phone_number: '+15551234567',
              friendly_name: 'My Number',
              capabilities: { voice: true, sms: true },
            },
            {
              phone_number: '+15559876543',
              friendly_name: 'Other Number',
              capabilities: { voice: true, sms: false },
            },
          ],
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'list_numbers',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean; numbers?: Array<{ phoneNumber: string; friendlyName: string; capabilities: { voice: boolean; sms: boolean } }> };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(true);
    expect(res.numbers).toHaveLength(2);
    expect(res.numbers![0].phoneNumber).toBe('+15551234567');
    expect(res.numbers![0].friendlyName).toBe('My Number');
    expect(res.numbers![0].capabilities.sms).toBe(true);
    expect(res.numbers![1].phoneNumber).toBe('+15559876543');
    expect(res.numbers![1].capabilities.sms).toBe(false);
  });

  test('list_numbers returns error when no credentials configured', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'list_numbers',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Twilio credentials not configured');
  });

  // ── provision_number ────────────────────────────────────────────────

  test('provision_number searches and provisions a number', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      // Search available numbers
      if (urlStr.includes('AvailablePhoneNumbers') && urlStr.includes('Local.json')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [
            {
              phone_number: '+15559999999',
              friendly_name: '(555) 999-9999',
              capabilities: { voice: true, sms: true },
            },
          ],
        }), { status: 200 });
      }
      // Purchase number
      if (urlStr.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          phone_number: '+15559999999',
          friendly_name: '(555) 999-9999',
          capabilities: { voice: true, sms: true },
        }), { status: 201 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
      country: 'US',
      areaCode: '555',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasCredentials: boolean; phoneNumber?: string };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(true);
    expect(res.hasCredentials).toBe(true);
    expect(res.phoneNumber).toBe('+15559999999');
  });

  test('provision_number auto-assigns the purchased number to config and secure storage', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('AvailablePhoneNumbers') && urlStr.includes('Local.json')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [{
            phone_number: '+15559999999',
            friendly_name: '(555) 999-9999',
            capabilities: { voice: true, sms: true },
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          phone_number: '+15559999999',
          friendly_name: '(555) 999-9999',
          capabilities: { voice: true, sms: true },
        }), { status: 201 });
      }
      // Webhook lookup (no ingress configured, will fail gracefully)
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
      country: 'US',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15559999999');

    // Verify the number was persisted in secure storage (same as assign_number)
    expect(secureKeyStore['credential:twilio:phone_number']).toBe('+15559999999');

    // Verify the number was persisted in the config file (same as assign_number)
    expect((rawConfigStore.sms as Record<string, unknown>)?.phoneNumber).toBe('+15559999999');
  });

  test('provision_number configures Twilio webhooks when ingress URL is available', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    rawConfigStore = { ingress: { enabled: true, publicBaseUrl: 'https://example.ngrok.io' } };

    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body?.toString() });

      if (urlStr.includes('AvailablePhoneNumbers') && urlStr.includes('Local.json')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [{
            phone_number: '+15559999999',
            friendly_name: '(555) 999-9999',
            capabilities: { voice: true, sms: true },
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers.json') && init?.method === 'POST'
          && init?.body?.toString().includes('PhoneNumber')) {
        return new Response(JSON.stringify({
          phone_number: '+15559999999',
          friendly_name: '(555) 999-9999',
          capabilities: { voice: true, sms: true },
        }), { status: 201 });
      }
      // Webhook number lookup
      if (urlStr.includes('IncomingPhoneNumbers.json') && urlStr.includes('PhoneNumber=')) {
        return new Response(JSON.stringify({
          incoming_phone_numbers: [{ sid: 'PN123abc', phone_number: '+15559999999' }],
        }), { status: 200 });
      }
      // Webhook update
      if (urlStr.includes('IncomingPhoneNumbers/PN123abc.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sid: 'PN123abc' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
      country: 'US',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // Find the webhook update call
    const webhookUpdate = fetchCalls.find((c) =>
      c.url.includes('IncomingPhoneNumbers/PN123abc.json') && c.method === 'POST',
    );
    expect(webhookUpdate).toBeDefined();

    // Verify the webhook URLs contain the expected ingress base URL paths
    const body = webhookUpdate!.body!;
    expect(body).toContain('VoiceUrl=');
    expect(body).toContain('webhooks%2Ftwilio%2Fvoice');
    expect(body).toContain('StatusCallback=');
    expect(body).toContain('webhooks%2Ftwilio%2Fstatus');
    expect(body).toContain('SmsUrl=');
    expect(body).toContain('webhooks%2Ftwilio%2Fsms');
  });

  test('provision_number succeeds with clear warning when ingress URL is missing', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    // No ingress config — webhook configuration will be skipped gracefully

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('AvailablePhoneNumbers') && urlStr.includes('Local.json')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [{
            phone_number: '+15559999999',
            friendly_name: '(555) 999-9999',
            capabilities: { voice: true, sms: true },
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          phone_number: '+15559999999',
          friendly_name: '(555) 999-9999',
          capabilities: { voice: true, sms: true },
        }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
      country: 'US',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    // The provision should still succeed — webhook config failure is non-fatal
    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15559999999');

    // Number should still be persisted even without webhook setup
    expect(secureKeyStore['credential:twilio:phone_number']).toBe('+15559999999');
    expect((rawConfigStore.sms as Record<string, unknown>)?.phoneNumber).toBe('+15559999999');
  });

  test('provision_number returns error when no numbers available', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('AvailablePhoneNumbers')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [],
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('No available phone numbers found');
  });

  test('provision_number returns error when no credentials configured', async () => {
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Twilio credentials not configured');
  });

  // ── Unknown action ──────────────────────────────────────────────────

  test('unrecognized action returns error response', async () => {
    const msg = {
      type: 'twilio_config',
      action: 'nonexistent_action',
    } as unknown as TwilioConfigRequest;

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe('twilio_config_response');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown action');
    expect(res.error).toContain('nonexistent_action');
  });

  // ── Ingress webhook reconciliation ──────────────────────────────────

  test('ingress config update triggers Twilio webhook sync when assigned number and credentials exist', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };

    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body?.toString() });

      // Webhook number lookup
      if (urlStr.includes('IncomingPhoneNumbers.json') && urlStr.includes('PhoneNumber=')) {
        return new Response(JSON.stringify({
          incoming_phone_numbers: [{ sid: 'PN123abc', phone_number: '+15551234567' }],
        }), { status: 200 });
      }
      // Webhook update
      if (urlStr.includes('IncomingPhoneNumbers/PN123abc.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sid: 'PN123abc' }), { status: 200 });
      }
      // Gateway reconcile (ignore)
      if (urlStr.includes('/internal/telegram/reconcile')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://new-tunnel.ngrok.io',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    await handleIngressConfig(msg, {} as net.Socket, ctx);

    // Ingress save should succeed
    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean; publicBaseUrl: string };
    expect(res.type).toBe('ingress_config_response');
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.publicBaseUrl).toBe('https://new-tunnel.ngrok.io');

    // Wait a tick for the fire-and-forget webhook sync to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify webhook update was attempted with the new ingress URL
    const webhookUpdate = fetchCalls.find((c) =>
      c.url.includes('IncomingPhoneNumbers/PN123abc.json') && c.method === 'POST',
    );
    expect(webhookUpdate).toBeDefined();
    const body = webhookUpdate!.body!;
    expect(body).toContain('VoiceUrl=');
    expect(body).toContain('new-tunnel.ngrok.io');
  });

  test('ingress config update reconciles all unique assigned Twilio numbers (legacy + assistant mapping)', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    rawConfigStore = {
      sms: {
        phoneNumber: '+15551234567',
        assistantPhoneNumbers: {
          'ast-alpha': '+15551234567', // duplicate of legacy; should only sync once
          'ast-beta': '+15553333333',
        },
      },
    };

    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body?.toString() });

      if (urlStr.includes('/internal/telegram/reconcile')) {
        return new Response('{}', { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers.json?PhoneNumber=')) {
        if (urlStr.includes('%2B15551234567')) {
          return new Response(JSON.stringify({
            incoming_phone_numbers: [{ sid: 'PN-legacy', phone_number: '+15551234567' }],
          }), { status: 200 });
        }
        if (urlStr.includes('%2B15553333333')) {
          return new Response(JSON.stringify({
            incoming_phone_numbers: [{ sid: 'PN-beta', phone_number: '+15553333333' }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ incoming_phone_numbers: [] }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers/PN-legacy.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sid: 'PN-legacy' }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers/PN-beta.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sid: 'PN-beta' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://multi-number.ngrok.io',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    await handleIngressConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean };
    expect(res.type).toBe('ingress_config_response');
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const lookupCalls = fetchCalls.filter((c) => c.url.includes('IncomingPhoneNumbers.json?PhoneNumber='));
    const lookedUpNumbers = lookupCalls
      .map((c) => decodeURIComponent(c.url.split('PhoneNumber=')[1] ?? ''))
      .sort();
    expect(lookedUpNumbers).toEqual(['+15551234567', '+15553333333']);

    const updateCalls = fetchCalls.filter((c) => c.method === 'POST' && c.url.includes('IncomingPhoneNumbers/PN-'));
    const updatedSids = updateCalls.map((c) => (c.url.includes('PN-legacy') ? 'PN-legacy' : 'PN-beta')).sort();
    expect(updatedSids).toEqual(['PN-beta', 'PN-legacy']);
    expect(updateCalls[0]?.body ?? '').toContain('multi-number.ngrok.io');
  });

  test('webhook sync failure on ingress update does not fail the ingress update', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };

    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      // Gateway reconcile (ignore)
      if (urlStr.includes('/internal/telegram/reconcile')) {
        return new Response('{}', { status: 200 });
      }
      // Webhook number lookup — simulate failure
      if (urlStr.includes('IncomingPhoneNumbers.json') && urlStr.includes('PhoneNumber=')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.ngrok.io',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    await handleIngressConfig(msg, {} as net.Socket, ctx);

    // The ingress update must still succeed despite the webhook sync failure
    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean };
    expect(res.type).toBe('ingress_config_response');
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);

    // Wait a tick for the fire-and-forget promise
    await new Promise((r) => setTimeout(r, 50));
  });

  test('ingress config update skips webhook sync when no Twilio credentials', async () => {
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };

    const fetchCalls: Array<{ url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.ngrok.io',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    await handleIngressConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // No Twilio API calls should have been made (only gateway reconcile)
    const twilioApiCalls = fetchCalls.filter((c) => c.url.includes('api.twilio.com'));
    expect(twilioApiCalls).toHaveLength(0);
  });

  test('ingress config update skips webhook sync when no assigned number', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    // No sms.phoneNumber in config

    const fetchCalls: Array<{ url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      fetchCalls.push({ url: urlStr });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.ngrok.io',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    await handleIngressConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // No Twilio API calls should have been made
    const twilioApiCalls = fetchCalls.filter((c) => c.url.includes('api.twilio.com'));
    expect(twilioApiCalls).toHaveLength(0);
  });

  // ── Warning field ─────────────────────────────────────────────────

  test('provision_number surfaces webhook warning when ingress is missing', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    // No ingress config — webhook configuration will produce a warning

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('AvailablePhoneNumbers') && urlStr.includes('Local.json')) {
        return new Response(JSON.stringify({
          available_phone_numbers: [{
            phone_number: '+15559999999',
            friendly_name: '(555) 999-9999',
            capabilities: { voice: true, sms: true },
          }],
        }), { status: 200 });
      }
      if (urlStr.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          phone_number: '+15559999999',
          friendly_name: '(555) 999-9999',
          capabilities: { voice: true, sms: true },
        }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'provision_number',
      country: 'US',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string; warning?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15559999999');
    // Warning should be present because no ingress URL is configured
    expect(res.warning).toBeDefined();
    expect(res.warning).toContain('Webhook configuration skipped');
  });

  test('assign_number surfaces webhook warning when Twilio API fails', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC1234567890abcdef1234567890abcdef';
    secureKeyStore['credential:twilio:auth_token'] = 'test_auth_token';
    rawConfigStore = { ingress: { enabled: true, publicBaseUrl: 'https://example.ngrok.io' } };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      // Webhook number lookup — simulate Twilio API error
      if (urlStr.includes('IncomingPhoneNumbers.json')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15551234567',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string; warning?: string };
    // Assignment itself succeeds
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15551234567');
    // Warning should surface the webhook failure
    expect(res.warning).toBeDefined();
    expect(res.warning).toContain('Webhook configuration skipped');
  });

  // ── Assistant-scoped phone number assignment ─────────────────────────

  test('get action with assistantId returns assistant-specific phone number', async () => {
    rawConfigStore = {
      sms: {
        phoneNumber: '+15551111111',
        assistantPhoneNumbers: { 'ast-alpha': '+15552222222', 'ast-beta': '+15553333333' },
      },
    };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'get',
      assistantId: 'ast-alpha',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    // Should return the assistant-specific number, not the legacy one
    expect(res.phoneNumber).toBe('+15552222222');
  });

  test('get action with assistantId falls back to legacy phoneNumber when no mapping exists', async () => {
    rawConfigStore = {
      sms: { phoneNumber: '+15551111111' },
    };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'get',
      assistantId: 'ast-unknown',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    // Should fall back to the legacy phoneNumber
    expect(res.phoneNumber).toBe('+15551111111');
  });

  test('assign_number with assistantId persists into assistantPhoneNumbers mapping', async () => {
    rawConfigStore = { sms: { phoneNumber: '+15551111111' } };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15554444444',
      assistantId: 'ast-gamma',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15554444444');

    // Legacy field should NOT be overwritten when assistantId is provided
    // and the field already has a value — prevents multi-assistant clobbering
    const sms = rawConfigStore.sms as Record<string, unknown>;
    expect(sms.phoneNumber).toBe('+15551111111');

    // Per-assistant mapping should contain the new assignment
    const mapping = sms.assistantPhoneNumbers as Record<string, string>;
    expect(mapping['ast-gamma']).toBe('+15554444444');
  });

  test('assign_number with assistantId sets legacy phoneNumber as fallback when empty', async () => {
    rawConfigStore = { sms: {} };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15554444444',
      assistantId: 'ast-gamma',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15554444444');

    // When no legacy phoneNumber exists, the first assistant assignment sets it as fallback
    const sms = rawConfigStore.sms as Record<string, unknown>;
    expect(sms.phoneNumber).toBe('+15554444444');

    // Per-assistant mapping should contain the new assignment
    const mapping = sms.assistantPhoneNumbers as Record<string, string>;
    expect(mapping['ast-gamma']).toBe('+15554444444');
  });

  test('assign_number with assistantId does not clobber existing global phoneNumber', async () => {
    // Simulate a multi-assistant scenario: assistant alpha already has a number assigned
    rawConfigStore = {
      sms: {
        phoneNumber: '+15551111111',
        assistantPhoneNumbers: { 'ast-alpha': '+15551111111' },
      },
    };

    // Now assign a different number to assistant beta
    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15552222222',
      assistantId: 'ast-beta',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; phoneNumber?: string };
    expect(res.success).toBe(true);
    expect(res.phoneNumber).toBe('+15552222222');

    const sms = rawConfigStore.sms as Record<string, unknown>;
    // The global phoneNumber should still be alpha's number, NOT beta's
    expect(sms.phoneNumber).toBe('+15551111111');

    // Both assistant mappings should be intact
    const mapping = sms.assistantPhoneNumbers as Record<string, string>;
    expect(mapping['ast-alpha']).toBe('+15551111111');
    expect(mapping['ast-beta']).toBe('+15552222222');
  });

  test('assign_number without assistantId does not write assistantPhoneNumbers', async () => {
    rawConfigStore = { sms: {} };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'assign_number',
      phoneNumber: '+15555555555',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    const sms = rawConfigStore.sms as Record<string, unknown>;
    expect(sms.phoneNumber).toBe('+15555555555');
    // No assistantPhoneNumbers should have been created
    expect(sms.assistantPhoneNumbers).toBeUndefined();
  });

  // ── Security ────────────────────────────────────────────────────────

  test('response messages never contain raw credential values', async () => {
    secureKeyStore['credential:twilio:account_sid'] = 'AC_secret_account_sid_12345';
    secureKeyStore['credential:twilio:auth_token'] = 'secret_auth_token_67890';
    rawConfigStore = { sms: { phoneNumber: '+15551234567' } };

    const msg: TwilioConfigRequest = {
      type: 'twilio_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTwilioConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const responseStr = JSON.stringify(sent[0]);
    // No raw credential values should leak into the response
    expect(responseStr).not.toContain('AC_secret_account_sid_12345');
    expect(responseStr).not.toContain('secret_auth_token_67890');
  });
});
