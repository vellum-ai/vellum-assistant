import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'handlers-twitter-auth-test-'));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};
let mockIngressPublicBaseUrl: string | undefined = 'https://test.example.com';

mock.module('../config/loader.js', () => ({
  getConfig: () => ({}),
  loadConfig: () => ({ ingress: { publicBaseUrl: mockIngressPublicBaseUrl } }),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module('../inbound/public-ingress-urls.js', () => ({
  getPublicBaseUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl;
    if (url) return url;
    throw new Error('No public base URL configured.');
  },
  getOAuthCallbackUrl: (config: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl;
    if (!url) throw new Error('No public base URL configured.');
    return `${url}/webhooks/oauth/callback`;
  },
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
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Mock secure key storage
let secureKeyStore: Record<string, string> = {};

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
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

// Mock OAuth2 flow
let oauthFlowResult: unknown = null;
let oauthFlowError: Error | null = null;
let lastOAuthFlowOptions: Record<string, unknown> | undefined;

mock.module('../security/oauth2.js', () => ({
  startOAuth2Flow: async (
    _config: unknown,
    callbacks: { openUrl: (url: string) => void },
    options?: Record<string, unknown>,
  ) => {
    lastOAuthFlowOptions = options;
    // Trigger the openUrl callback so tests can verify the open_url message is sent
    callbacks.openUrl('https://twitter.com/i/oauth2/authorize?test=1');
    if (oauthFlowError) throw oauthFlowError;
    return oauthFlowResult;
  },
}));

// Mock credential metadata store
let credentialMetadataStore: Array<{ service: string; field: string; accountInfo?: string }> = [];
let lastUpsertPolicy: Record<string, unknown> | undefined;

mock.module('../tools/credentials/metadata-store.js', () => ({
  getCredentialMetadata: (service: string, field: string) =>
    credentialMetadataStore.find((m) => m.service === service && m.field === field) ?? undefined,
  upsertCredentialMetadata: (service: string, field: string, policy?: Record<string, unknown>) => {
    lastUpsertPolicy = policy;
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

import { handleMessage, type HandlerContext } from '../daemon/handlers.js';
import type {
  TwitterAuthStartRequest,
  TwitterAuthStatusRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';
import { DebouncerMap } from '../util/debounce.js';

// Mock global fetch for Twitter /2/users/me
const _originalFetch = globalThis.fetch;
let mockFetchResponse: { ok: boolean; json: () => Promise<unknown> } = {
  ok: true,
  json: async () => ({ data: { username: 'testuser' } }),
};

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

describe('Twitter auth handler', () => {
  beforeEach(() => {
    rawConfigStore = {};
    secureKeyStore = {};
    credentialMetadataStore = [];
    oauthFlowResult = null;
    oauthFlowError = null;
    lastUpsertPolicy = undefined;
    lastOAuthFlowOptions = undefined;
    mockIngressPublicBaseUrl = 'https://test.example.com';
    // Mock fetch for Twitter API
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return mockFetchResponse;
    }) as typeof fetch;
    mockFetchResponse = {
      ok: true,
      json: async () => ({ data: { username: 'testuser' } }),
    };
  });

  // Restore original fetch after all tests
  // (bun:test doesn't have afterAll in all versions, but the test process exits anyway)

  describe('twitter_auth_start', () => {
    test('fails if mode is not local_byo', async () => {
      rawConfigStore = { twitterIntegrationMode: 'managed' };

      const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      // handleMessage returns void, the async handler runs; wait a tick
      await new Promise((r) => setTimeout(r, 10));

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const result = sent.find((m) => m.type === 'twitter_auth_result') as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('local_byo');
    });

    test('fails if no client credentials configured', async () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };
      // No client ID in secure storage

      const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 10));

      expect(sent.length).toBeGreaterThanOrEqual(1);
      const result = sent.find((m) => m.type === 'twitter_auth_result') as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('client credentials');
    });

    test('succeeds with valid config (mock OAuth flow + Twitter API)', async () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };
      secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';
      secureKeyStore['credential:integration:twitter:oauth_client_secret'] = 'test-client-secret';

      oauthFlowResult = {
        tokens: {
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          expiresIn: 7200,
          scope: 'tweet.read users.read offline.access',
          tokenType: 'bearer',
        },
        grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
        rawTokenResponse: {},
      };

      const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      // Should have sent open_url and then twitter_auth_result
      const openUrlMsg = sent.find((m) => m.type === 'open_url');
      expect(openUrlMsg).toBeDefined();

      const result = sent.find((m) => m.type === 'twitter_auth_result') as {
        type: string;
        success: boolean;
        accountInfo?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.accountInfo).toBe('@testuser');

      // Verify tokens were stored
      expect(secureKeyStore['credential:integration:twitter:access_token']).toBe('mock-access-token');
      expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBe('mock-refresh-token');

      // Verify credential metadata was stored
      const meta = credentialMetadataStore.find(
        (m) => m.service === 'integration:twitter' && m.field === 'access_token',
      );
      expect(meta).toBeDefined();
      expect(meta!.accountInfo).toBe('@testuser');
    });

    test('passes callbackTransport: gateway to startOAuth2Flow', async () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };
      secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

      oauthFlowResult = {
        tokens: {
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          expiresIn: 7200,
          scope: 'tweet.read users.read offline.access',
          tokenType: 'bearer',
        },
        grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
        rawTokenResponse: {},
      };

      const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
      const { ctx } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      // Verify startOAuth2Flow was called with gateway transport
      expect(lastOAuthFlowOptions).toBeDefined();
      expect(lastOAuthFlowOptions!.callbackTransport).toBe('gateway');
    });

    test('fails fast with actionable error when no ingress URL is configured', async () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };
      secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';
      mockIngressPublicBaseUrl = undefined;

      oauthFlowResult = {
        tokens: { accessToken: 'should-not-reach', refreshToken: undefined },
        grantedScopes: [],
        rawTokenResponse: {},
      };

      const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
      const { ctx, sent } = createTestContext();
      await handleMessage(msg, {} as net.Socket, ctx);

      await new Promise((r) => setTimeout(r, 50));

      // Should NOT have sent open_url — the flow should fail before reaching OAuth
      const openUrlMsg = sent.find((m) => m.type === 'open_url');
      expect(openUrlMsg).toBeUndefined();

      const result = sent.find((m) => m.type === 'twitter_auth_result') as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain('ingress.publicBaseUrl');
      expect(result.error).toContain('INGRESS_PUBLIC_BASE_URL');
      expect(result.error).toContain('/webhooks/oauth/callback');

      // startOAuth2Flow should not have been called
      expect(lastOAuthFlowOptions).toBeUndefined();
    });

    describe('auth hardening', () => {
      test('OAuth cancel path returns sanitized failure', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

        oauthFlowError = new Error('OAuth2 authorization denied: user_cancelled');

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Twitter authentication was cancelled.');

        // No tokens should have been stored
        expect(secureKeyStore['credential:integration:twitter:access_token']).toBeUndefined();
        expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBeUndefined();

        // No credential metadata should have been created
        expect(credentialMetadataStore).toHaveLength(0);
      });

      test('OAuth timeout path returns sanitized failure', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

        oauthFlowError = new Error('OAuth2 flow timed out waiting for user authorization');

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Twitter authentication timed out. Please try again.');

        // No tokens stored
        expect(secureKeyStore['credential:integration:twitter:access_token']).toBeUndefined();
        expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBeUndefined();

        // No metadata created
        expect(credentialMetadataStore).toHaveLength(0);
      });

      test('verification endpoint non-2xx causes auth failure', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

        oauthFlowResult = {
          tokens: {
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            expiresIn: 7200,
            scope: 'tweet.read users.read offline.access',
            tokenType: 'bearer',
          },
          grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
          rawTokenResponse: {},
        };

        mockFetchResponse = { ok: false, json: async () => ({}) };

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);

        // No tokens should have been persisted
        expect(secureKeyStore['credential:integration:twitter:access_token']).toBeUndefined();
        expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBeUndefined();

        // No credential metadata
        expect(credentialMetadataStore).toHaveLength(0);
      });

      test('verification payload missing username causes auth failure', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

        oauthFlowResult = {
          tokens: {
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            expiresIn: 7200,
            scope: 'tweet.read users.read offline.access',
            tokenType: 'bearer',
          },
          grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
          rawTokenResponse: {},
        };

        mockFetchResponse = { ok: true, json: async () => ({ data: {} }) };

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);

        // No tokens or metadata persisted
        expect(secureKeyStore['credential:integration:twitter:access_token']).toBeUndefined();
        expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBeUndefined();
        expect(credentialMetadataStore).toHaveLength(0);
      });

      test('re-auth without refresh token clears stale stored refresh token', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';
        // Pre-populate a stale refresh token
        secureKeyStore['credential:integration:twitter:refresh_token'] = 'old-stale-token';

        oauthFlowResult = {
          tokens: {
            accessToken: 'new-access-token',
            refreshToken: undefined,
            expiresIn: 7200,
            scope: 'tweet.read users.read offline.access',
            tokenType: 'bearer',
          },
          grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
          rawTokenResponse: {},
        };

        mockFetchResponse = {
          ok: true,
          json: async () => ({ data: { username: 'testuser' } }),
        };

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(true);

        // New access token should be set
        expect(secureKeyStore['credential:integration:twitter:access_token']).toBe('new-access-token');
        // Stale refresh token should have been deleted, not left as 'old-stale-token'
        expect(secureKeyStore['credential:integration:twitter:refresh_token']).toBeUndefined();
      });

      test('error payload never includes secrets or raw provider bodies', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'test-client-id';

        oauthFlowError = new Error(
          'OAuth2 token exchange failed (403): {"error":"invalid_client","client_secret":"super-secret-123"}',
        );

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
          error?: string;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(false);

        // The error should NOT contain any secrets or raw provider details
        expect(result.error).not.toContain('super-secret-123');
        expect(result.error).not.toContain('invalid_client');
        expect(result.error).not.toContain('client_secret');

        // Should fall to default classification since the raw message does not match
        // "denied", "invalid_grant", "timed out", or "cancelled"
        expect(result.error).toBe('Twitter authentication failed. Please try again.');
      });

      test('full metadata fields are persisted on success', async () => {
        rawConfigStore = { twitterIntegrationMode: 'local_byo' };
        secureKeyStore['credential:integration:twitter:oauth_client_id'] = 'my-client-id';
        secureKeyStore['credential:integration:twitter:oauth_client_secret'] = 'my-client-secret';

        oauthFlowResult = {
          tokens: {
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            expiresIn: 7200,
            scope: 'tweet.read users.read offline.access',
            tokenType: 'bearer',
          },
          grantedScopes: ['tweet.read', 'users.read', 'offline.access'],
          rawTokenResponse: {},
        };

        mockFetchResponse = {
          ok: true,
          json: async () => ({ data: { username: 'testuser' } }),
        };

        const msg: TwitterAuthStartRequest = { type: 'twitter_auth_start' };
        const { ctx, sent } = createTestContext();
        await handleMessage(msg, {} as net.Socket, ctx);

        await new Promise((r) => setTimeout(r, 50));

        const result = sent.find((m) => m.type === 'twitter_auth_result') as {
          type: string;
          success: boolean;
        };
        expect(result).toBeDefined();
        expect(result.success).toBe(true);

        // Verify the full policy was captured
        expect(lastUpsertPolicy).toBeDefined();
        expect(lastUpsertPolicy!.oauth2TokenUrl).toBe('https://api.x.com/2/oauth2/token');
        expect(lastUpsertPolicy!.oauth2ClientId).toBe('my-client-id');
        expect(lastUpsertPolicy!.oauth2ClientSecret).toBe('my-client-secret');
        expect(lastUpsertPolicy!.grantedScopes).toEqual(['tweet.read', 'users.read', 'offline.access']);
        expect(lastUpsertPolicy!.allowedDomains).toEqual([]);
        expect(lastUpsertPolicy!.allowedTools).toEqual(['twitter_post']);

        // expiresAt should be roughly Date.now() + 7200 * 1000
        const expiresAt = lastUpsertPolicy!.expiresAt as number;
        expect(typeof expiresAt).toBe('number');
        expect(expiresAt).toBeGreaterThan(Date.now() + 7100 * 1000);
        expect(expiresAt).toBeLessThan(Date.now() + 7300 * 1000);
      });
    });
  });

  describe('twitter_auth_status', () => {
    test('returns disconnected when no token exists', () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };

      const msg: TwitterAuthStatusRequest = { type: 'twitter_auth_status' };
      const { ctx, sent } = createTestContext();
      handleMessage(msg, {} as net.Socket, ctx);

      expect(sent).toHaveLength(1);
      const result = sent[0] as {
        type: string;
        connected: boolean;
        accountInfo?: string;
        mode?: string;
      };
      expect(result.type).toBe('twitter_auth_status_response');
      expect(result.connected).toBe(false);
      expect(result.accountInfo).toBeUndefined();
      expect(result.mode).toBe('local_byo');
    });

    test('returns connected with account info when token exists', () => {
      rawConfigStore = { twitterIntegrationMode: 'local_byo' };
      secureKeyStore['credential:integration:twitter:access_token'] = 'test-access-token';
      credentialMetadataStore.push({
        service: 'integration:twitter',
        field: 'access_token',
        accountInfo: '@testuser',
      });

      const msg: TwitterAuthStatusRequest = { type: 'twitter_auth_status' };
      const { ctx, sent } = createTestContext();
      handleMessage(msg, {} as net.Socket, ctx);

      expect(sent).toHaveLength(1);
      const result = sent[0] as {
        type: string;
        connected: boolean;
        accountInfo?: string;
        mode?: string;
      };
      expect(result.type).toBe('twitter_auth_status_response');
      expect(result.connected).toBe(true);
      expect(result.accountInfo).toBe('@testuser');
      expect(result.mode).toBe('local_byo');
    });
  });
});
