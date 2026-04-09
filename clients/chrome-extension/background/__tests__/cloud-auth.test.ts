/**
 * Tests for the cloud OAuth state machine.
 *
 * These tests mock the `chrome.identity.launchWebAuthFlow` and
 * `chrome.storage.local` surfaces so they can run under bun:test without
 * a real Chrome runtime.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  getStoredToken,
  getStoredTokenRaw,
  clearStoredToken,
  signInCloud,
  refreshCloudToken,
  isCloudTokenStale,
  CLOUD_TOKEN_STALE_WINDOW_MS,
  CLOUD_AUTH_FAILURE_CLOSE_CODES,
  type CloudAuthConfig,
  type StoredCloudToken,
} from '../cloud-auth.js';

const STORAGE_KEY = 'vellum.cloudAuthToken';

interface FakeStorage {
  data: Record<string, unknown>;
  get(key: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in data) result[k] = data[k];
      }
      return result;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    },
  };
}

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

let fakeStorage: FakeStorage;
let launchWebAuthFlowImpl: (details: { url: string; interactive: boolean }) => Promise<string | undefined>;

beforeEach(() => {
  fakeStorage = createFakeStorage();
  launchWebAuthFlowImpl = async () => undefined;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: fakeStorage,
    },
    identity: {
      getRedirectURL: (path: string) => `https://fakeextid.chromiumapp.org/${path}`,
      launchWebAuthFlow: (details: { url: string; interactive: boolean }) => launchWebAuthFlowImpl(details),
    },
  };
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

const config: CloudAuthConfig = {
  gatewayBaseUrl: 'https://api.vellum.ai',
  clientId: 'test-client-id',
};

describe('signInCloud', () => {
  test('happy path stores a token and returns it', async () => {
    launchWebAuthFlowImpl = async (details) => {
      // The redirect URL the gateway would send back.
      expect(details.url).toContain('https://api.vellum.ai/oauth/chrome-extension/start');
      expect(details.url).toContain('client_id=test-client-id');
      expect(details.interactive).toBe(true);
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&expires_in=3600&guardian_id=g-42';
    };

    const before = Date.now();
    const result = await signInCloud(config);
    const after = Date.now();

    expect(result.token).toBe('abc123');
    expect(result.guardianId).toBe('g-42');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);

    // Verify it was persisted.
    expect(fakeStorage.data[STORAGE_KEY]).toEqual(result);
  });

  test('missing token rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#expires_in=3600&guardian_id=g-42';

    await expect(signInCloud(config)).rejects.toThrow('incomplete payload');
    expect(fakeStorage.data[STORAGE_KEY]).toBeUndefined();
  });

  test('missing expires_in rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&guardian_id=g-42';

    await expect(signInCloud(config)).rejects.toThrow('incomplete payload');
  });

  test('missing guardian_id rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&expires_in=3600';

    await expect(signInCloud(config)).rejects.toThrow('incomplete payload');
  });

  test('cancelled flow rejects with "cancelled"', async () => {
    launchWebAuthFlowImpl = async () => undefined;

    await expect(signInCloud(config)).rejects.toThrow('cancelled');
    expect(fakeStorage.data[STORAGE_KEY]).toBeUndefined();
  });

  test('trims trailing slash on gatewayBaseUrl', async () => {
    let seenUrl = '';
    launchWebAuthFlowImpl = async (details) => {
      seenUrl = details.url;
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc&expires_in=60&guardian_id=g1';
    };
    await signInCloud({ gatewayBaseUrl: 'https://api.vellum.ai/', clientId: 'cid' });
    expect(seenUrl).toContain('https://api.vellum.ai/oauth/chrome-extension/start');
    expect(seenUrl).not.toContain('api.vellum.ai//oauth');
  });
});

describe('getStoredToken', () => {
  test('returns null when nothing is stored', async () => {
    expect(await getStoredToken()).toBeNull();
  });

  test('returns the stored token when valid', async () => {
    const token: StoredCloudToken = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[STORAGE_KEY] = token;

    expect(await getStoredToken()).toEqual(token);
  });

  test('returns null when the token is expired', async () => {
    fakeStorage.data[STORAGE_KEY] = {
      token: 'expired',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    } satisfies StoredCloudToken;

    expect(await getStoredToken()).toBeNull();
  });

  test('returns null when the stored value is malformed', async () => {
    fakeStorage.data[STORAGE_KEY] = { token: 42, expiresAt: 'soon' };

    expect(await getStoredToken()).toBeNull();
  });

  test('returns null when guardianId is missing or non-string', async () => {
    // Missing guardianId entirely — would otherwise render as "guardian:undefined" in the popup.
    fakeStorage.data[STORAGE_KEY] = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
    };
    expect(await getStoredToken()).toBeNull();

    // Non-string guardianId (e.g. a number).
    fakeStorage.data[STORAGE_KEY] = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 42,
    };
    expect(await getStoredToken()).toBeNull();
  });
});

describe('clearStoredToken', () => {
  test('removes the key from storage', async () => {
    fakeStorage.data[STORAGE_KEY] = {
      token: 'to-clear',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    } satisfies StoredCloudToken;

    await clearStoredToken();
    expect(fakeStorage.data[STORAGE_KEY]).toBeUndefined();
  });

  test('is a no-op when nothing is stored', async () => {
    await clearStoredToken();
    expect(fakeStorage.data[STORAGE_KEY]).toBeUndefined();
  });
});

describe('getStoredTokenRaw', () => {
  test('returns an expired token (unlike getStoredToken)', async () => {
    const expired: StoredCloudToken = {
      token: 'expired',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[STORAGE_KEY] = expired;

    // getStoredToken hides expired tokens…
    expect(await getStoredToken()).toBeNull();
    // …but getStoredTokenRaw surfaces them so the reconnect path
    // can tell "signed in but expired" apart from "never signed in".
    expect(await getStoredTokenRaw()).toEqual(expired);
  });

  test('returns null when nothing is stored', async () => {
    expect(await getStoredTokenRaw()).toBeNull();
  });

  test('returns null when the stored value is malformed', async () => {
    fakeStorage.data[STORAGE_KEY] = { token: 42, expiresAt: 'soon' };
    expect(await getStoredTokenRaw()).toBeNull();
  });
});

describe('isCloudTokenStale', () => {
  test('null token counts as stale', () => {
    expect(isCloudTokenStale(null)).toBe(true);
  });

  test('token expiring inside the stale window counts as stale', () => {
    const now = 1_000_000;
    const token: StoredCloudToken = {
      token: 't',
      expiresAt: now + CLOUD_TOKEN_STALE_WINDOW_MS - 1,
      guardianId: 'g-1',
    };
    expect(isCloudTokenStale(token, now)).toBe(true);
  });

  test('token expiring well after the stale window is fresh', () => {
    const now = 1_000_000;
    const token: StoredCloudToken = {
      token: 't',
      expiresAt: now + CLOUD_TOKEN_STALE_WINDOW_MS * 10,
      guardianId: 'g-1',
    };
    expect(isCloudTokenStale(token, now)).toBe(false);
  });

  test('already-expired token counts as stale', () => {
    const now = 1_000_000;
    const token: StoredCloudToken = {
      token: 't',
      expiresAt: now - 1,
      guardianId: 'g-1',
    };
    expect(isCloudTokenStale(token, now)).toBe(true);
  });
});

describe('CLOUD_AUTH_FAILURE_CLOSE_CODES', () => {
  test('covers the gateway auth-failure application codes', () => {
    // Mirrors the codes emitted by the gateway's browser-relay
    // handshake. Pinned here so a future refactor can't accidentally
    // drop one without updating this invariant.
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4001)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4002)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4003)).toBe(true);
    // 1008 ("policy violation") is included for intermediaries that
    // rewrite application codes back to the standard range.
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1008)).toBe(true);
    // Normal close codes are NOT in the set — they represent clean
    // shutdowns, not auth failures.
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1000)).toBe(false);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1006)).toBe(false);
  });
});

describe('refreshCloudToken', () => {
  test('happy path: non-interactive flow persists and returns the new token', async () => {
    let seenInteractive: boolean | undefined;
    launchWebAuthFlowImpl = async (details) => {
      seenInteractive = details.interactive;
      expect(details.url).toContain('https://api.vellum.ai/oauth/chrome-extension/start');
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=fresh-jwt&expires_in=3600&guardian_id=g-99';
    };

    const before = Date.now();
    const result = await refreshCloudToken(config);
    expect(result).not.toBeNull();
    const token = result as StoredCloudToken;

    expect(seenInteractive).toBe(false);
    expect(token.token).toBe('fresh-jwt');
    expect(token.guardianId).toBe('g-99');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);

    // Token was persisted to storage so future reads see the new one.
    expect(fakeStorage.data[STORAGE_KEY]).toEqual(token);
  });

  test('returns null when Chrome rejects for interaction required', async () => {
    launchWebAuthFlowImpl = async () => {
      throw new Error('OAuth2 not granted or revoked.');
    };

    // Pre-seed a stale token so we can verify it isn't clobbered.
    const stale: StoredCloudToken = {
      token: 'stale-jwt',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[STORAGE_KEY] = stale;

    const result = await refreshCloudToken(config);
    expect(result).toBeNull();
    // The stale token is left in place — the reconnect path uses this
    // to decide whether to surface a sign-in prompt to the user.
    expect(fakeStorage.data[STORAGE_KEY]).toEqual(stale);
  });

  test('returns null when launchWebAuthFlow resolves with undefined', async () => {
    launchWebAuthFlowImpl = async () => undefined;
    expect(await refreshCloudToken(config)).toBeNull();
  });

  test('throws when the gateway returns an incomplete payload', async () => {
    // A malformed response from the gateway is an unexpected error and
    // should bubble up to the service-worker logs — we only swallow
    // the "interaction required" family of Chrome rejections.
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#guardian_id=g-42';

    await expect(refreshCloudToken(config)).rejects.toThrow('incomplete payload');
  });
});
