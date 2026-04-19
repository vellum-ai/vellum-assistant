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
  cloudTokenStorageKey,
  CLOUD_TOKEN_STALE_WINDOW_MS,
  CLOUD_AUTH_FAILURE_CLOSE_CODES,
  type CloudAuthConfig,
  type StoredCloudToken,
} from '../cloud-auth.js';

const ASSISTANT_A = 'assistant-alpha';
const ASSISTANT_B = 'assistant-beta';

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
  webBaseUrl: 'https://www.vellum.ai',
  clientId: 'test-client-id',
};

describe('cloudTokenStorageKey', () => {
  test('builds a colon-separated key', () => {
    expect(cloudTokenStorageKey('my-assistant')).toBe(
      'vellum.cloudAuthToken:my-assistant',
    );
  });
});

describe('signInCloud', () => {
  test('happy path stores a token and returns it', async () => {
    launchWebAuthFlowImpl = async (details) => {
      // The redirect URL the gateway would send back.
      expect(details.url).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
      expect(details.url).toContain('client_id=test-client-id');
      expect(details.url).toContain(`assistant_id=${ASSISTANT_A}`);
      expect(details.interactive).toBe(true);
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&expires_in=3600&guardian_id=g-42';
    };

    const before = Date.now();
    const result = await signInCloud(ASSISTANT_A, config);
    const after = Date.now();

    expect(result.token).toBe('abc123');
    expect(result.guardianId).toBe('g-42');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);

    // Verify it was persisted under the assistant-scoped key.
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(result);
  });

  test('missing token rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#expires_in=3600&guardian_id=g-42';

    await expect(signInCloud(ASSISTANT_A, config)).rejects.toThrow('incomplete payload');
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });

  test('missing expires_in rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&guardian_id=g-42';

    await expect(signInCloud(ASSISTANT_A, config)).rejects.toThrow('incomplete payload');
  });

  test('missing guardian_id rejects with "incomplete payload"', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#token=abc123&expires_in=3600';

    await expect(signInCloud(ASSISTANT_A, config)).rejects.toThrow('incomplete payload');
  });

  test('cancelled flow rejects with "cancelled"', async () => {
    launchWebAuthFlowImpl = async () => undefined;

    await expect(signInCloud(ASSISTANT_A, config)).rejects.toThrow('cancelled');
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });

  test('trims trailing slash on webBaseUrl', async () => {
    let seenUrl = '';
    launchWebAuthFlowImpl = async (details) => {
      seenUrl = details.url;
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc&expires_in=60&guardian_id=g1';
    };
    await signInCloud(ASSISTANT_A, { webBaseUrl: 'https://www.vellum.ai/', clientId: 'cid' });
    expect(seenUrl).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
    expect(seenUrl).not.toContain('www.vellum.ai//accounts');
  });

  test('retries without assistant_id when Chrome reports auth page load failure', async () => {
    const seenUrls: string[] = [];
    launchWebAuthFlowImpl = async (details) => {
      seenUrls.push(details.url);
      if (seenUrls.length === 1) {
        throw new Error('Authorization page could not be loaded.');
      }
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc&expires_in=60&guardian_id=g1';
    };

    await signInCloud(ASSISTANT_A, config);

    expect(seenUrls.length).toBe(2);
    expect(seenUrls[0]).toContain(`assistant_id=${ASSISTANT_A}`);
    expect(seenUrls[1]).not.toContain('assistant_id=');
  });

  test('does not retry against platform runtime host for auth fallback', async () => {
    const seenUrls: string[] = [];
    launchWebAuthFlowImpl = async (details) => {
      seenUrls.push(details.url);
      throw new Error('Authorization page could not be loaded.');
    };

    await expect(
      signInCloud(ASSISTANT_A, {
        ...config,
        runtimeBaseUrl: 'https://platform.vellum.ai',
      }),
    ).rejects.toThrow('Authorization page could not be loaded.');

    // platform.vellum.ai remaps to www.vellum.ai, so both runtime
    // fallback attempts are deduped against the primary base URL.
    expect(seenUrls.length).toBe(2);
    expect(seenUrls[0]).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
    expect(seenUrls[1]).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
  });

  test('retries against assistant-web host derived from runtimeBaseUrl', async () => {
    const seenUrls: string[] = [];
    launchWebAuthFlowImpl = async (details) => {
      seenUrls.push(details.url);
      if (seenUrls.length < 3) {
        throw new Error('Authorization page could not be loaded.');
      }
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=abc&expires_in=60&guardian_id=g1';
    };

    await signInCloud(ASSISTANT_A, {
      ...config,
      runtimeBaseUrl: 'https://dev-platform.vellum.ai',
    });

    expect(seenUrls.length).toBe(3);
    expect(seenUrls[0]).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
    expect(seenUrls[1]).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
    expect(seenUrls[2]).toContain('https://dev-assistant.vellum.ai/accounts/chrome-extension/start');
  });
});

describe('getStoredToken', () => {
  test('returns null when nothing is stored', async () => {
    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
  });

  test('returns the stored token when valid', async () => {
    const token: StoredCloudToken = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = token;

    expect(await getStoredToken(ASSISTANT_A)).toEqual(token);
  });

  test('returns null when the token is expired', async () => {
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = {
      token: 'expired',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    } satisfies StoredCloudToken;

    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
  });

  test('returns null when the stored value is malformed', async () => {
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = { token: 42, expiresAt: 'soon' };

    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
  });

  test('returns null when guardianId is missing or non-string', async () => {
    // Missing guardianId entirely.
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
    };
    expect(await getStoredToken(ASSISTANT_A)).toBeNull();

    // Non-string guardianId (e.g. a number).
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = {
      token: 'valid-token',
      expiresAt: Date.now() + 60_000,
      guardianId: 42,
    };
    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
  });
});

describe('clearStoredToken', () => {
  test('removes the key from storage', async () => {
    const key = cloudTokenStorageKey(ASSISTANT_A);
    fakeStorage.data[key] = {
      token: 'to-clear',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-1',
    } satisfies StoredCloudToken;

    await clearStoredToken(ASSISTANT_A);
    expect(fakeStorage.data[key]).toBeUndefined();
  });

  test('is a no-op when nothing is stored', async () => {
    await clearStoredToken(ASSISTANT_A);
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });
});

describe('getStoredTokenRaw', () => {
  test('returns an expired token (unlike getStoredToken)', async () => {
    const expired: StoredCloudToken = {
      token: 'expired',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-1',
    };
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = expired;

    // getStoredToken hides expired tokens.
    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
    // getStoredTokenRaw surfaces them so the reconnect path
    // can tell "signed in but expired" apart from "never signed in".
    expect(await getStoredTokenRaw(ASSISTANT_A)).toEqual(expired);
  });

  test('returns null when nothing is stored', async () => {
    expect(await getStoredTokenRaw(ASSISTANT_A)).toBeNull();
  });

  test('returns null when the stored value is malformed', async () => {
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = { token: 42, expiresAt: 'soon' };
    expect(await getStoredTokenRaw(ASSISTANT_A)).toBeNull();
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
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4001)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4002)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(4003)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1008)).toBe(true);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1000)).toBe(false);
    expect(CLOUD_AUTH_FAILURE_CLOSE_CODES.has(1006)).toBe(false);
  });
});

describe('refreshCloudToken', () => {
  test('happy path: non-interactive flow persists and returns the new token', async () => {
    let seenInteractive: boolean | undefined;
    launchWebAuthFlowImpl = async (details) => {
      seenInteractive = details.interactive;
      expect(details.url).toContain('https://www.vellum.ai/accounts/chrome-extension/start');
      expect(details.url).toContain(`assistant_id=${ASSISTANT_A}`);
      return 'https://fakeextid.chromiumapp.org/cloud-auth#token=fresh-jwt&expires_in=3600&guardian_id=g-99';
    };

    const before = Date.now();
    const result = await refreshCloudToken(ASSISTANT_A, config);
    expect(result).not.toBeNull();
    const token = result as StoredCloudToken;

    expect(seenInteractive).toBe(false);
    expect(token.token).toBe('fresh-jwt');
    expect(token.guardianId).toBe('g-99');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);

    // Token was persisted to storage under the assistant-scoped key.
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(token);
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
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = stale;

    const result = await refreshCloudToken(ASSISTANT_A, config);
    expect(result).toBeNull();
    // The stale token is left in place.
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(stale);
  });

  test('returns null when launchWebAuthFlow resolves with undefined', async () => {
    launchWebAuthFlowImpl = async () => undefined;
    expect(await refreshCloudToken(ASSISTANT_A, config)).toBeNull();
  });

  test('throws when the gateway returns an incomplete payload', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#guardian_id=g-42';

    await expect(refreshCloudToken(ASSISTANT_A, config)).rejects.toThrow('incomplete payload');
  });
});

describe('assistant token isolation', () => {
  test('tokens stored for different assistants do not interfere', async () => {
    const tokenA: StoredCloudToken = {
      token: 'cloud-alpha',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-alpha',
    };
    const tokenB: StoredCloudToken = {
      token: 'cloud-beta',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-beta',
    };
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = tokenA;
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_B)] = tokenB;

    expect(await getStoredToken(ASSISTANT_A)).toEqual(tokenA);
    expect(await getStoredToken(ASSISTANT_B)).toEqual(tokenB);
  });

  test('clearing one assistant token does not affect another', async () => {
    const tokenA: StoredCloudToken = {
      token: 'cloud-alpha',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-alpha',
    };
    const tokenB: StoredCloudToken = {
      token: 'cloud-beta',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-beta',
    };
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = tokenA;
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_B)] = tokenB;

    await clearStoredToken(ASSISTANT_A);

    expect(await getStoredToken(ASSISTANT_A)).toBeNull();
    expect(await getStoredToken(ASSISTANT_B)).toEqual(tokenB);
  });

  test('signInCloud persists under the correct assistant-scoped key', async () => {
    launchWebAuthFlowImpl = async () =>
      'https://fakeextid.chromiumapp.org/cloud-auth#token=scoped-jwt&expires_in=3600&guardian_id=g-scoped';

    await signInCloud(ASSISTANT_B, config);

    // Only ASSISTANT_B's key should be populated.
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_B)]).not.toBeUndefined();
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toBeUndefined();
  });
});

describe('legacy token migration (cloud)', () => {
  const LEGACY_KEY = 'vellum.cloudAuthToken';

  test('getStoredToken migrates a valid legacy token to the scoped key', async () => {
    const legacyToken: StoredCloudToken = {
      token: 'legacy-jwt',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-legacy',
    };
    fakeStorage.data[LEGACY_KEY] = legacyToken;

    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toEqual(legacyToken);

    // Legacy key was removed.
    expect(fakeStorage.data[LEGACY_KEY]).toBeUndefined();
    // Scoped key was populated.
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(legacyToken);
  });

  test('getStoredTokenRaw migrates a valid legacy token to the scoped key', async () => {
    const legacyToken: StoredCloudToken = {
      token: 'legacy-raw',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-legacy-raw',
    };
    fakeStorage.data[LEGACY_KEY] = legacyToken;

    const result = await getStoredTokenRaw(ASSISTANT_A);
    expect(result).toEqual(legacyToken);

    // Legacy key was removed, scoped key was populated.
    expect(fakeStorage.data[LEGACY_KEY]).toBeUndefined();
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(legacyToken);
  });

  test('getStoredTokenRaw migrates an expired legacy token (returns it without expiry check)', async () => {
    const expiredLegacy: StoredCloudToken = {
      token: 'expired-legacy',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-expired',
    };
    fakeStorage.data[LEGACY_KEY] = expiredLegacy;

    // getStoredTokenRaw does not filter by expiry, but validateCloudToken
    // also does not filter by expiry — only getStoredToken does. However,
    // the migration helper uses validateCloudToken which does NOT check
    // expiry, so getStoredTokenRaw will surface the expired token.
    const result = await getStoredTokenRaw(ASSISTANT_A);
    expect(result).toEqual(expiredLegacy);
  });

  test('getStoredToken returns null for an expired legacy token', async () => {
    const expiredLegacy: StoredCloudToken = {
      token: 'expired-legacy',
      expiresAt: Date.now() - 1_000,
      guardianId: 'g-expired',
    };
    fakeStorage.data[LEGACY_KEY] = expiredLegacy;

    // getStoredToken applies the expiry check, so expired legacy tokens
    // are not surfaced (but they are still migrated).
    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toBeNull();
  });

  test('migration does not clobber an existing scoped token', async () => {
    const scopedToken: StoredCloudToken = {
      token: 'scoped-jwt',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-scoped',
    };
    const legacyToken: StoredCloudToken = {
      token: 'legacy-jwt',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-legacy',
    };
    fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)] = scopedToken;
    fakeStorage.data[LEGACY_KEY] = legacyToken;

    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toEqual(scopedToken);
    // Legacy key is NOT removed because the scoped key already existed.
    expect(fakeStorage.data[LEGACY_KEY]).toEqual(legacyToken);
  });

  test('migration is idempotent — second call is a no-op', async () => {
    const legacyToken: StoredCloudToken = {
      token: 'legacy-jwt',
      expiresAt: Date.now() + 60_000,
      guardianId: 'g-legacy',
    };
    fakeStorage.data[LEGACY_KEY] = legacyToken;

    // First call migrates.
    await getStoredToken(ASSISTANT_A);
    expect(fakeStorage.data[LEGACY_KEY]).toBeUndefined();

    // Second call is a no-op — the scoped key exists and the legacy key
    // is gone, so migration does nothing.
    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toEqual(legacyToken);
    expect(fakeStorage.data[cloudTokenStorageKey(ASSISTANT_A)]).toEqual(legacyToken);
  });

  test('migration ignores a malformed legacy value', async () => {
    fakeStorage.data[LEGACY_KEY] = { token: 42, expiresAt: 'soon' };

    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toBeNull();
    // Malformed legacy key is not cleaned up — only valid tokens are migrated.
  });

  test('migration returns null when no legacy key exists', async () => {
    const result = await getStoredToken(ASSISTANT_A);
    expect(result).toBeNull();
  });
});
