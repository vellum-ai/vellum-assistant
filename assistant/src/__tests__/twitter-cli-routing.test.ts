import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mocks (must be declared before importing the module under test) ---

let mockStrategy: string | undefined = undefined;
let mockOauthAvailable = false;
let mockOauthPostResult: { tweetId: string; text: string; url?: string } | null = null;
let mockOauthPostError: Error | null = null;
let mockBrowserPostResult: { tweetId: string; text: string; url: string } | null = null;
let mockBrowserPostError: Error | null = null;

// Mock the config loader to return a controllable strategy
mock.module('../config/loader.js', () => ({
  loadRawConfig: () => {
    if (mockStrategy !== undefined) {
      return { twitterOperationStrategy: mockStrategy };
    }
    return {};
  },
  loadConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  API_KEY_PROVIDERS: [],
}));

// Mock the OAuth client
mock.module('../twitter/oauth-client.js', () => ({
  oauthIsAvailable: () => mockOauthAvailable,
  oauthSupportsOperation: (op: string) => op === 'post' || op === 'reply',
  oauthPostTweet: async (_text: string, _opts?: { inReplyToTweetId?: string }) => {
    if (mockOauthPostError) throw mockOauthPostError;
    if (mockOauthPostResult) return mockOauthPostResult;
    throw new Error('OAuth mock not configured');
  },
  UnsupportedOAuthOperationError: class UnsupportedOAuthOperationError extends Error {
    public readonly suggestFallback = true;
    public readonly fallbackPath = 'browser' as const;
    public readonly operation: string;
    constructor(operation: string) {
      super(`The "${operation}" operation is not available via the OAuth API.`);
      this.name = 'UnsupportedOAuthOperationError';
      this.operation = operation;
    }
  },
}));

// Create a SessionExpiredError class that matches the real one
class MockSessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionExpiredError';
  }
}

// Mock the browser client
mock.module('../twitter/client.js', () => ({
  postTweet: async (_text: string, _opts?: { inReplyToTweetId?: string }) => {
    if (mockBrowserPostError) throw mockBrowserPostError;
    if (mockBrowserPostResult) return mockBrowserPostResult;
    throw new Error('Browser mock not configured');
  },
  SessionExpiredError: MockSessionExpiredError,
}));

// Mock the logger to silence output
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

import { routedPostTweet } from '../twitter/router.js';

beforeEach(() => {
  mockStrategy = undefined;
  mockOauthAvailable = false;
  mockOauthPostResult = null;
  mockOauthPostError = null;
  mockBrowserPostResult = null;
  mockBrowserPostError = null;
});

describe('Twitter strategy router', () => {
  describe('auto strategy', () => {
    test('uses OAuth when available and supported', async () => {
      mockOauthAvailable = true;
      mockOauthPostResult = { tweetId: '111', text: 'hello', url: 'https://x.com/u/status/111' };

      const { result, pathUsed } = await routedPostTweet('hello');

      expect(pathUsed).toBe('oauth');
      expect(result.tweetId).toBe('111');
      expect(result.text).toBe('hello');
      expect(result.url).toBe('https://x.com/u/status/111');
    });

    test('falls back to browser when OAuth is unavailable', async () => {
      mockOauthAvailable = false;
      mockBrowserPostResult = { tweetId: '222', text: 'hello', url: 'https://x.com/u/status/222' };

      const { result, pathUsed } = await routedPostTweet('hello');

      expect(pathUsed).toBe('browser');
      expect(result.tweetId).toBe('222');
    });

    test('falls back to browser when OAuth fails', async () => {
      mockOauthAvailable = true;
      mockOauthPostError = new Error('OAuth token expired');
      mockBrowserPostResult = { tweetId: '333', text: 'hello', url: 'https://x.com/u/status/333' };

      const { result, pathUsed } = await routedPostTweet('hello');

      expect(pathUsed).toBe('browser');
      expect(result.tweetId).toBe('333');
    });

    test('constructs URL from tweetId when OAuth result has no url', async () => {
      mockOauthAvailable = true;
      mockOauthPostResult = { tweetId: '444', text: 'no url' };

      const { result, pathUsed } = await routedPostTweet('no url');

      expect(pathUsed).toBe('oauth');
      expect(result.url).toBe('https://x.com/i/status/444');
    });

    test('throws combined error when both OAuth and browser fail with SessionExpiredError', async () => {
      mockOauthAvailable = true;
      mockOauthPostError = new Error('OAuth failed');
      mockBrowserPostError = new MockSessionExpiredError('Browser session expired');

      try {
        await routedPostTweet('will fail');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & { pathUsed: string };
        expect(e).toBeInstanceOf(MockSessionExpiredError);
        expect(e.message).toBe('Browser session expired');
        expect(e.pathUsed).toBe('auto');
      }
    });
  });

  describe('explicit oauth strategy', () => {
    test('fails with helpful error when OAuth is not configured', async () => {
      mockStrategy = 'oauth';
      mockOauthAvailable = false;

      try {
        await routedPostTweet('hello');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & { pathUsed: string; suggestAlternative: string };
        expect(e.message).toContain('OAuth is not configured');
        expect(e.message).toContain('vellum x strategy set browser');
        expect(e.pathUsed).toBe('oauth');
        expect(e.suggestAlternative).toBe('browser');
      }
    });

    test('uses OAuth when available', async () => {
      mockStrategy = 'oauth';
      mockOauthAvailable = true;
      mockOauthPostResult = { tweetId: '555', text: 'oauth post' };

      const { result, pathUsed } = await routedPostTweet('oauth post');

      expect(pathUsed).toBe('oauth');
      expect(result.tweetId).toBe('555');
    });
  });

  describe('explicit browser strategy', () => {
    test('uses browser directly, ignoring OAuth availability', async () => {
      mockStrategy = 'browser';
      mockOauthAvailable = true; // available but should be ignored
      mockBrowserPostResult = { tweetId: '666', text: 'browser post', url: 'https://x.com/u/status/666' };

      const { result, pathUsed } = await routedPostTweet('browser post');

      expect(pathUsed).toBe('browser');
      expect(result.tweetId).toBe('666');
    });

    test('preserves SessionExpiredError type with router metadata', async () => {
      mockStrategy = 'browser';
      mockBrowserPostError = new MockSessionExpiredError('Session expired');

      try {
        await routedPostTweet('will fail');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        const e = err as Error & { pathUsed: string; suggestAlternative: string };
        expect(e).toBeInstanceOf(MockSessionExpiredError);
        expect(e.message).toBe('Session expired');
        expect(e.pathUsed).toBe('browser');
        expect(e.suggestAlternative).toBe('oauth');
      }
    });

    test('re-throws non-session errors without wrapping', async () => {
      mockStrategy = 'browser';
      mockBrowserPostError = new Error('Network failure');

      try {
        await routedPostTweet('will fail');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect((err as Error).message).toBe('Network failure');
      }
    });
  });

  describe('reply routing', () => {
    test('auto strategy routes reply through OAuth when available', async () => {
      mockOauthAvailable = true;
      mockOauthPostResult = { tweetId: '777', text: 'reply text', url: 'https://x.com/u/status/777' };

      const { result, pathUsed } = await routedPostTweet('reply text', { inReplyToTweetId: '100' });

      expect(pathUsed).toBe('oauth');
      expect(result.tweetId).toBe('777');
    });

    test('browser strategy routes reply through browser', async () => {
      mockStrategy = 'browser';
      mockBrowserPostResult = { tweetId: '888', text: 'reply text', url: 'https://x.com/u/status/888' };

      const { result, pathUsed } = await routedPostTweet('reply text', { inReplyToTweetId: '200' });

      expect(pathUsed).toBe('browser');
      expect(result.tweetId).toBe('888');
    });
  });
});
