import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'handlers-telegram-cfg-test-'));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({}),
  loadConfig: () => ({}),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

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

// Mock fetch for Telegram getMe API validation
let fetchMock: ((url: string | URL | Request) => Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;

import { handleTelegramConfig } from '../daemon/handlers/config.js';
import type { HandlerContext } from '../daemon/handlers.js';
import type {
  TelegramConfigRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new Map(),
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

describe('Telegram config handler', () => {
  beforeEach(() => {
    rawConfigStore = {};
    secureKeyStore = {};
    setSecureKeyOverride = null;
    credentialMetadataStore = [];
    deletedMetadata.length = 0;
    fetchMock = null;
    globalThis.fetch = originalFetch;
  });

  test('get action returns correct state when not configured', async () => {
    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean; hasWebhookSecret: boolean };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.hasWebhookSecret).toBe(false);
  });

  test('get action returns correct state when configured', async () => {
    secureKeyStore['credential:telegram:bot_token'] = 'test-bot-token';
    secureKeyStore['credential:telegram:webhook_secret'] = 'test-webhook-secret';
    credentialMetadataStore.push({
      service: 'telegram',
      field: 'bot_token',
      accountInfo: 'my_test_bot',
    });

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; botUsername: string; connected: boolean; hasWebhookSecret: boolean };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(true);
    expect(res.botUsername).toBe('my_test_bot');
    expect(res.connected).toBe(true);
    expect(res.hasWebhookSecret).toBe(true);
  });

  test('set action validates token, stores credentials, returns success', async () => {
    // Mock successful Telegram getMe response
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; botUsername: string; connected: boolean; hasWebhookSecret: boolean };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(true);
    expect(res.botUsername).toBe('test_bot');
    expect(res.connected).toBe(true);
    expect(res.hasWebhookSecret).toBe(true);

    // Verify token was stored
    expect(secureKeyStore['credential:telegram:bot_token']).toBe('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
    // Verify webhook secret was generated
    expect(secureKeyStore['credential:telegram:webhook_secret']).toBeDefined();
    // Verify metadata was stored
    expect(credentialMetadataStore.find((m) => m.service === 'telegram' && m.field === 'bot_token')?.accountInfo).toBe('test_bot');
  });

  test('set action with invalid token returns error', async () => {
    // Mock failed Telegram getMe response
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 401,
          description: 'Unauthorized',
        }), { status: 401 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: 'invalid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Telegram API validation failed');

    // Verify token was NOT stored
    expect(secureKeyStore['credential:telegram:bot_token']).toBeUndefined();
  });

  test('set action without botToken returns error', async () => {
    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('botToken is required');
  });

  test('clear action removes credentials', async () => {
    secureKeyStore['credential:telegram:bot_token'] = 'test-bot-token';
    secureKeyStore['credential:telegram:webhook_secret'] = 'test-webhook-secret';
    credentialMetadataStore.push({
      service: 'telegram',
      field: 'bot_token',
      accountInfo: 'my_test_bot',
    });
    credentialMetadataStore.push({
      service: 'telegram',
      field: 'webhook_secret',
    });

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'clear',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean; hasWebhookSecret: boolean };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.hasWebhookSecret).toBe(false);

    // Verify everything was cleaned up
    expect(secureKeyStore['credential:telegram:bot_token']).toBeUndefined();
    expect(secureKeyStore['credential:telegram:webhook_secret']).toBeUndefined();
    expect(deletedMetadata).toContainEqual({ service: 'telegram', field: 'bot_token' });
    expect(deletedMetadata).toContainEqual({ service: 'telegram', field: 'webhook_secret' });
  });

  test('clear action is idempotent when no credentials exist', async () => {
    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'clear',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean; hasWebhookSecret: boolean };
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.hasWebhookSecret).toBe(false);
  });

  test('set action preserves existing webhook secret', async () => {
    // Pre-populate webhook secret
    secureKeyStore['credential:telegram:webhook_secret'] = 'existing-secret';

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasWebhookSecret: boolean };
    expect(res.success).toBe(true);
    expect(res.hasWebhookSecret).toBe(true);

    // Existing webhook secret should not be overwritten
    expect(secureKeyStore['credential:telegram:webhook_secret']).toBe('existing-secret');
  });

  test('set action upserts webhook_secret metadata even when secret already exists', async () => {
    // Pre-populate webhook secret WITHOUT metadata to simulate lost/corrupted metadata
    secureKeyStore['credential:telegram:webhook_secret'] = 'existing-secret';

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // Metadata for webhook_secret should have been upserted even though the
    // secret already existed (self-heal for lost/corrupted metadata)
    const webhookMeta = credentialMetadataStore.find(
      (m) => m.service === 'telegram' && m.field === 'webhook_secret',
    );
    expect(webhookMeta).toBeDefined();
  });

  test('set action fails when secure storage fails', async () => {
    setSecureKeyOverride = () => false;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to store bot token');
  });

  test('unrecognized action returns error response', async () => {
    const msg = {
      type: 'telegram_config',
      action: 'nonexistent_action',
    } as unknown as TelegramConfigRequest;

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.type).toBe('telegram_config_response');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown action');
    expect(res.error).toContain('nonexistent_action');
  });

  test('response messages never contain raw bot token values', async () => {
    secureKeyStore['credential:telegram:bot_token'] = 'secret-bot-token-abc123';
    secureKeyStore['credential:telegram:webhook_secret'] = 'secret-webhook-xyz789';
    credentialMetadataStore.push({
      service: 'telegram',
      field: 'bot_token',
      accountInfo: 'my_test_bot',
    });

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const responseStr = JSON.stringify(sent[0]);
    // No raw credential values should leak into the response
    expect(responseStr).not.toContain('secret-bot-token-abc123');
    expect(responseStr).not.toContain('secret-webhook-xyz789');
  });

  test('set action handles getMe returning unexpected response', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot' },
          // username is missing
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('unexpected response');
  });

  test('set action handles network error during getMe', async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => {
      throw new Error('Network error: ECONNREFUSED');
    }) as unknown as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to validate bot token');
    expect(res.error).toContain('ECONNREFUSED');
  });

  test('get action reports connected only when both bot_token and webhook_secret exist', async () => {
    // Only bot_token, no webhook_secret — should NOT be connected
    secureKeyStore['credential:telegram:bot_token'] = 'test-bot-token';

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(
      { type: 'telegram_config', action: 'get' },
      {} as net.Socket,
      ctx,
    );

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean; hasWebhookSecret: boolean };
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(true);
    expect(res.hasWebhookSecret).toBe(false);
    expect(res.connected).toBe(false);
  });

  test('set action rolls back bot token when webhook secret storage fails', async () => {
    // Let bot token storage succeed but webhook secret storage fail
    setSecureKeyOverride = (account: string, value: string) => {
      if (account === 'credential:telegram:webhook_secret') return false;
      secureKeyStore[account] = value;
      return true;
    };

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.telegram.org') && urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 123456, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const msg: TelegramConfigRequest = {
      type: 'telegram_config',
      action: 'set',
      botToken: '123456:valid-token',
    };

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(msg, {} as net.Socket, ctx);

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean; hasWebhookSecret: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe('Failed to store webhook secret');
    expect(res.hasBotToken).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.hasWebhookSecret).toBe(false);

    // Bot token should have been rolled back
    expect(secureKeyStore['credential:telegram:bot_token']).toBeUndefined();
    // Metadata should have been cleaned up
    expect(credentialMetadataStore.find((m) => m.service === 'telegram' && m.field === 'bot_token')).toBeUndefined();
  });

  test('clear action deregisters webhook before deleting credentials', async () => {
    secureKeyStore['credential:telegram:bot_token'] = 'test-bot-token';
    secureKeyStore['credential:telegram:webhook_secret'] = 'test-webhook-secret';
    credentialMetadataStore.push({ service: 'telegram', field: 'bot_token', accountInfo: 'my_test_bot' });
    credentialMetadataStore.push({ service: 'telegram', field: 'webhook_secret' });

    let deleteWebhookCalled = false;
    let deleteWebhookUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('/deleteWebhook')) {
        deleteWebhookCalled = true;
        deleteWebhookUrl = urlStr;
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return originalFetch(url);
    }) as typeof fetch;

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(
      { type: 'telegram_config', action: 'clear' },
      {} as net.Socket,
      ctx,
    );

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // deleteWebhook should have been called with the bot token
    expect(deleteWebhookCalled).toBe(true);
    expect(deleteWebhookUrl).toContain('test-bot-token');

    // Credentials should still be cleaned up
    expect(secureKeyStore['credential:telegram:bot_token']).toBeUndefined();
    expect(secureKeyStore['credential:telegram:webhook_secret']).toBeUndefined();
  });

  test('clear action proceeds even when webhook deregistration fails', async () => {
    secureKeyStore['credential:telegram:bot_token'] = 'test-bot-token';
    secureKeyStore['credential:telegram:webhook_secret'] = 'test-webhook-secret';

    globalThis.fetch = (async (_url: string | URL | Request) => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const { ctx, sent } = createTestContext();
    await handleTelegramConfig(
      { type: 'telegram_config', action: 'clear' },
      {} as net.Socket,
      ctx,
    );

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; hasBotToken: boolean; connected: boolean };
    expect(res.success).toBe(true);
    expect(res.hasBotToken).toBe(false);
    expect(res.connected).toBe(false);

    // Credentials should still be cleaned up despite webhook deregistration failure
    expect(secureKeyStore['credential:telegram:bot_token']).toBeUndefined();
    expect(secureKeyStore['credential:telegram:webhook_secret']).toBeUndefined();
  });
});
