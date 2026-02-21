import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// --- Mocks (must be declared before importing the module under test) ---

let secureKeyStore: Record<string, string> = {};

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
  setSecureKey: (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  },
  deleteSecureKey: () => true,
  listSecureKeys: () => Object.keys(secureKeyStore),
  getBackendType: () => 'encrypted',
  isDowngradedFromKeychain: () => false,
  _resetBackend: () => {},
  _setBackend: () => {},
}));

// withValidToken: call the callback directly with a fake token.
mock.module('../security/token-manager.js', () => ({
  withValidToken: async (_service: string, cb: (token: string) => Promise<unknown>) =>
    cb('fake-oauth-token'),
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor(public readonly service: string, message?: string) {
      super(message ?? `Token expired for "${service}".`);
      this.name = 'TokenExpiredError';
    }
  },
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

import {
  oauthPostTweet,
  oauthIsAvailable,
  oauthSupportsOperation,
  UnsupportedOAuthOperationError,
} from '../twitter/oauth-client.js';

// --- Global fetch mock ---

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock> | null = null;

beforeEach(() => {
  secureKeyStore = {};
  fetchMock = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: { ok: boolean; status: number; json?: unknown; text?: string }) {
  const fn = mock(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.json),
      text: () => Promise.resolve(response.text ?? ''),
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  fetchMock = fn;
  return fn;
}

describe('Twitter OAuth client', () => {
  describe('oauthPostTweet', () => {
    test('successfully posts and returns tweet ID', async () => {
      const fn = mockFetch({
        ok: true,
        status: 200,
        json: { data: { id: '12345', text: 'Hello world' } },
      });

      const result = await oauthPostTweet('Hello world');

      expect(result.tweetId).toBe('12345');
      expect(result.text).toBe('Hello world');

      // Verify the request was made correctly
      expect(fn).toHaveBeenCalledTimes(1);
      const [url, opts] = fn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.x.com/2/tweets');
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer fake-oauth-token');
      expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(opts.body as string);
      expect(body.text).toBe('Hello world');
      expect(body.reply).toBeUndefined();
    });

    test('with reply returns correct result', async () => {
      const fn = mockFetch({
        ok: true,
        status: 200,
        json: { data: { id: '67890', text: 'My reply' } },
      });

      const result = await oauthPostTweet('My reply', { inReplyToTweetId: '11111' });

      expect(result.tweetId).toBe('67890');
      expect(result.text).toBe('My reply');

      const [, opts] = fn.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.text).toBe('My reply');
      expect(body.reply).toEqual({ in_reply_to_tweet_id: '11111' });
    });

    test('throws on API error', async () => {
      mockFetch({
        ok: false,
        status: 429,
        text: 'Rate limit exceeded',
      });

      await expect(oauthPostTweet('will fail')).rejects.toThrow(
        /Twitter API error \(429\)/,
      );
    });

    test('attaches status to thrown error for token manager retry', async () => {
      mockFetch({
        ok: false,
        status: 401,
        text: 'Unauthorized',
      });

      try {
        await oauthPostTweet('will fail');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect((err as Error & { status: number }).status).toBe(401);
      }
    });
  });

  describe('oauthIsAvailable', () => {
    test('returns true when access token exists', () => {
      secureKeyStore['credential:integration:twitter:access_token'] = 'some-token';
      expect(oauthIsAvailable()).toBe(true);
    });

    test('returns false when no access token', () => {
      expect(oauthIsAvailable()).toBe(false);
    });
  });

  describe('oauthSupportsOperation', () => {
    test('returns true for post', () => {
      expect(oauthSupportsOperation('post')).toBe(true);
    });

    test('returns true for reply', () => {
      expect(oauthSupportsOperation('reply')).toBe(true);
    });

    test('returns false for unsupported operations', () => {
      const unsupported = [
        'timeline',
        'search',
        'bookmarks',
        'home',
        'notifications',
        'likes',
        'followers',
        'following',
        'media',
        'tweet',
      ];
      for (const op of unsupported) {
        expect(oauthSupportsOperation(op)).toBe(false);
      }
    });
  });

  describe('UnsupportedOAuthOperationError', () => {
    test('has correct properties', () => {
      const err = new UnsupportedOAuthOperationError('search');
      expect(err.name).toBe('UnsupportedOAuthOperationError');
      expect(err.operation).toBe('search');
      expect(err.suggestFallback).toBe(true);
      expect(err.fallbackPath).toBe('browser');
      expect(err.message).toContain('search');
      expect(err.message).toContain('not available via the OAuth API');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
