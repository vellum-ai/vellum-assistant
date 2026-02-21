import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockPublicBaseUrl = '';

mock.module('../config/loader.js', () => ({
  loadConfig: () => ({
    ingress: { publicBaseUrl: mockPublicBaseUrl },
  }),
  getConfig: () => ({
    ingress: { publicBaseUrl: mockPublicBaseUrl },
  }),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  invalidateConfigCache: () => {},
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

// Track registerPendingCallback calls
const pendingCallbacks: Map<string, { resolve: (code: string) => void; reject: (error: Error) => void }> = new Map();

mock.module('../security/oauth-callback-registry.js', () => ({
  registerPendingCallback: (state: string, resolve: (code: string) => void, reject: (error: Error) => void) => {
    pendingCallbacks.set(state, { resolve, reject });
  },
  consumeCallback: () => true,
  consumeCallbackError: () => true,
  clearAllCallbacks: () => { pendingCallbacks.clear(); },
}));

let mockOAuthCallbackUrl = '';

mock.module('../inbound/public-ingress-urls.js', () => ({
  getOAuthCallbackUrl: () => mockOAuthCallbackUrl,
  getPublicBaseUrl: (config?: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl ?? mockPublicBaseUrl;
    if (!url) {
      throw new Error('No public base URL configured.');
    }
    return url;
  },
}));

// Mock fetch for token exchange
let mockTokenResponse: { ok: boolean; status: number; body: Record<string, unknown> } = {
  ok: true,
  status: 200,
  body: {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    scope: 'read write',
    token_type: 'Bearer',
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('token')) {
    if (!mockTokenResponse.ok) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: mockTokenResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(mockTokenResponse.body), {
      status: mockTokenResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { startOAuth2Flow, type OAuth2Config } from '../security/oauth2.js';

const BASE_OAUTH_CONFIG: OAuth2Config = {
  authUrl: 'https://provider.example.com/authorize',
  tokenUrl: 'https://provider.example.com/token',
  scopes: ['read', 'write'],
  clientId: 'test-client-id',
};

beforeEach(() => {
  mockPublicBaseUrl = '';
  mockOAuthCallbackUrl = 'https://gw.example.com/webhooks/oauth/callback';
  pendingCallbacks.clear();
  mockTokenResponse = {
    ok: true,
    status: 200,
    body: {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      scope: 'read write',
      token_type: 'Bearer',
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuth2 gateway transport', () => {
  describe('auto-detection', () => {
    test('selects gateway transport when ingress.publicBaseUrl is configured', async () => {
      mockPublicBaseUrl = 'https://gw.example.com';

      let capturedAuthUrl = '';
      const flowPromise = startOAuth2Flow(BASE_OAUTH_CONFIG, {
        openUrl: (url) => { capturedAuthUrl = url; },
      });

      // Give the flow a tick to register the callback and open the browser
      await new Promise((r) => setTimeout(r, 10));

      // The auth URL should contain the gateway redirect_uri, not a loopback one
      expect(capturedAuthUrl).toContain('redirect_uri=');
      expect(capturedAuthUrl).not.toContain('127.0.0.1');
      expect(capturedAuthUrl).toContain(encodeURIComponent('https://gw.example.com'));

      // Resolve the pending callback to complete the flow
      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);
      const [, { resolve }] = entries[0];
      resolve('auth-code-from-gateway');

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe('test-access-token');
    });

    test('selects loopback transport when ingress.publicBaseUrl is empty', async () => {
      mockPublicBaseUrl = '';

      let capturedAuthUrl = '';
      const flowPromise = startOAuth2Flow(BASE_OAUTH_CONFIG, {
        openUrl: (url) => { capturedAuthUrl = url; },
      });

      // Give the flow a tick
      await new Promise((r) => setTimeout(r, 10));

      // The auth URL should contain a loopback redirect_uri
      expect(capturedAuthUrl).toContain('redirect_uri=');
      expect(capturedAuthUrl).toContain('127.0.0.1');

      // Extract the redirect_uri to send the callback
      const authUrlParsed = new URL(capturedAuthUrl);
      const redirectUri = authUrlParsed.searchParams.get('redirect_uri')!;
      const stateParam = authUrlParsed.searchParams.get('state')!;

      // Simulate the OAuth provider callback to the loopback server
      const callbackUrl = `${redirectUri}?code=loopback-code&state=${stateParam}`;
      await fetch(callbackUrl);

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe('test-access-token');
    });
  });

  describe('explicit transport', () => {
    test('uses gateway transport when explicitly specified', async () => {
      // Even with no publicBaseUrl, explicit gateway should work
      mockPublicBaseUrl = 'https://gw.example.com';

      let capturedAuthUrl = '';
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: (url) => { capturedAuthUrl = url; } },
        { callbackTransport: 'gateway' },
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedAuthUrl).toContain(encodeURIComponent('https://gw.example.com'));

      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);
      entries[0][1].resolve('explicit-gateway-code');

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe('test-access-token');
    });

    test('uses loopback transport when explicitly specified', async () => {
      // Even with publicBaseUrl configured, explicit loopback should work
      mockPublicBaseUrl = 'https://gw.example.com';

      let capturedAuthUrl = '';
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: (url) => { capturedAuthUrl = url; } },
        { callbackTransport: 'loopback' },
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedAuthUrl).toContain('127.0.0.1');

      const authUrlParsed = new URL(capturedAuthUrl);
      const redirectUri = authUrlParsed.searchParams.get('redirect_uri')!;
      const stateParam = authUrlParsed.searchParams.get('state')!;

      await fetch(`${redirectUri}?code=loopback-code&state=${stateParam}`);

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe('test-access-token');
    });
  });

  describe('gateway transport flow', () => {
    test('success: register callback, consume with code, exchange for tokens', async () => {
      mockPublicBaseUrl = 'https://gw.example.com';

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: 'gateway' },
      );

      await new Promise((r) => setTimeout(r, 10));

      // A callback should be registered
      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);

      // Simulate gateway delivering the authorization code
      const [state, { resolve }] = entries[0];
      expect(typeof state).toBe('string');
      expect(state.length).toBeGreaterThan(0);

      resolve('gateway-auth-code');

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe('test-access-token');
      expect(result.tokens.refreshToken).toBe('test-refresh-token');
      expect(result.tokens.expiresIn).toBe(3600);
      expect(result.grantedScopes).toEqual(['read', 'write']);
    });

    test('error: register callback, consume with error, rejects', async () => {
      mockPublicBaseUrl = 'https://gw.example.com';

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: 'gateway' },
      );

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);

      // Simulate the gateway delivering an error (e.g. user denied access)
      const [, { reject }] = entries[0];
      reject(new Error('OAuth2 authorization denied: access_denied'));

      await expect(flowPromise).rejects.toThrow('OAuth2 authorization denied: access_denied');
    });

    test('token exchange failure propagates error', async () => {
      mockPublicBaseUrl = 'https://gw.example.com';
      mockTokenResponse = { ok: false, status: 400, body: { error: 'invalid_grant' } };

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: 'gateway' },
      );

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      entries[0][1].resolve('code-that-fails-exchange');

      await expect(flowPromise).rejects.toThrow('OAuth2 token exchange failed');
    });
  });
});
