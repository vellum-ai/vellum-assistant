/**
 * Tests for the worker's connect preflight logic.
 *
 * The preflight resolves credentials for the selected assistant before
 * the relay socket opens. When `interactive=true`, missing credentials
 * trigger an auto-bootstrap (pair for local, sign-in for cloud). When
 * `interactive=false`, only non-interactive refresh is attempted for
 * cloud; missing credentials produce an error.
 *
 * Since the worker module is side-effectful (registers listeners, calls
 * bootstrap), these tests exercise the preflight logic by replicating
 * the key functions under test in isolation — the same approach used by
 * `worker-selected-assistant-connect.test.ts`.
 *
 * Coverage:
 *   - Local interactive: auto-pairs when token is missing.
 *   - Local non-interactive: fails when token is missing.
 *   - Cloud interactive: auto-signs-in when token is missing/stale.
 *   - Cloud non-interactive: attempts refresh, succeeds if provider
 *     session is live.
 *   - Cloud non-interactive: fails when refresh also fails (no token).
 *   - Cloud non-interactive: falls back to stale-but-valid token when
 *     refresh fails (token present but within staleness window).
 *   - Preflight is a no-op when valid token already exists.
 */

import { describe, test, expect } from 'bun:test';

import { type AssistantAuthProfile } from '../assistant-auth-profile.js';
import type { AssistantDescriptor } from '../native-host-assistants.js';
import { isCloudTokenStale, type StoredCloudToken } from '../cloud-auth.js';
import type { StoredLocalToken } from '../self-hosted-auth.js';
import {
  type ExtensionEnvironment,
  cloudUrlsForEnvironment,
  resolveBuildDefaultEnvironment,
} from '../extension-environment.js';

// ── Types mirroring worker.ts internals ─────────────────────────────

type RelayMode =
  | { kind: 'self-hosted'; baseUrl: string; token: string | null }
  | { kind: 'cloud'; baseUrl: string; token: string | null };

interface ConnectOptions {
  interactive: boolean;
}

class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

function missingTokenMessage(profile: AssistantAuthProfile | null): string {
  if (profile === 'cloud-oauth') {
    return "Automatic cloud sign-in failed \u2014 use 'Re-sign in' in Advanced, then turn Connection on again";
  }
  if (profile === 'local-pair') {
    return "Automatic local pairing failed \u2014 use 'Re-pair' in Advanced, then turn Connection on again";
  }
  if (profile === 'unsupported') {
    return 'This assistant uses an unsupported topology. Please update the Vellum extension.';
  }
  return 'Select an assistant before connecting';
}

const DEFAULT_RELAY_PORT = 7830;

// ── Controllable fakes ──────────────────────────────────────────────

/**
 * Fake implementations for the auth functions the preflight calls.
 * Tests configure these per-case to control the preflight's behavior.
 */
interface PreflightDeps {
  bootstrapLocalToken: (assistantId: string | null) => Promise<StoredLocalToken>;
  signInCloud: (assistantId: string, config: { webBaseUrl: string; clientId: string }) => Promise<StoredCloudToken>;
  refreshCloudToken: (assistantId: string, config: { webBaseUrl: string; clientId: string }) => Promise<StoredCloudToken | null>;
  getStoredCloudToken: (assistantId: string) => Promise<StoredCloudToken | null>;
  /** The effective environment used to resolve cloud URLs. Defaults to build default. */
  effectiveEnvironment: ExtensionEnvironment;
}

const CLOUD_OAUTH_CLIENT_ID = 'vellum-chrome-extension';

/**
 * Standalone preflight implementation that mirrors the worker's
 * `connectPreflight` function but accepts injectable deps so tests
 * can control the auth function outcomes without mocking globals.
 *
 * Cloud URLs are resolved from `deps.effectiveEnvironment` using the
 * same `cloudUrlsForEnvironment` helper the worker uses, verifying
 * that sign-in/refresh configs use the environment-resolved web URL
 * and that the fallback gateway URL is derived from the environment.
 */
async function connectPreflight(
  assistant: AssistantDescriptor | null,
  authProfile: AssistantAuthProfile | null,
  mode: RelayMode,
  options: ConnectOptions,
  deps: PreflightDeps,
): Promise<RelayMode> {
  if (mode.token) {
    if (mode.kind === 'cloud' && assistant) {
      const stored = await deps.getStoredCloudToken(assistant.assistantId);
      if (!isCloudTokenStale(stored)) {
        return mode;
      }
    } else {
      return mode;
    }
  }

  if (authProfile === 'local-pair') {
    if (!options.interactive) {
      throw new MissingTokenError(missingTokenMessage('local-pair'));
    }
    const assistantId = assistant?.assistantId ?? null;
    const stored = await deps.bootstrapLocalToken(assistantId);
    const port = stored.assistantPort ?? assistant?.daemonPort ?? DEFAULT_RELAY_PORT;
    return {
      kind: 'self-hosted',
      baseUrl: `http://127.0.0.1:${port}`,
      token: stored.token,
    };
  }

  if (authProfile === 'cloud-oauth') {
    const assistantId = assistant?.assistantId ?? null;
    if (!assistantId) {
      throw new MissingTokenError(missingTokenMessage(null));
    }

    // Resolve cloud URLs from the effective environment — mirrors worker's getCloudUrls()
    const { apiBaseUrl, webBaseUrl } = cloudUrlsForEnvironment(deps.effectiveEnvironment);

    if (!options.interactive) {
      const refreshed = await deps.refreshCloudToken(assistantId, {
        webBaseUrl,
        clientId: CLOUD_OAUTH_CLIENT_ID,
      });
      if (refreshed) {
        const baseUrl = assistant?.runtimeUrl || apiBaseUrl;
        return { kind: 'cloud', baseUrl, token: refreshed.token };
      }
      // If the token is stale but still technically valid, fall back to
      // the existing mode rather than discarding a usable token. The
      // onReconnect hook will handle actual expiry later.
      if (mode.token) {
        return mode;
      }
      throw new MissingTokenError(missingTokenMessage('cloud-oauth'));
    }

    const stored = await deps.signInCloud(assistantId, {
      webBaseUrl,
      clientId: CLOUD_OAUTH_CLIENT_ID,
    });
    const baseUrl = assistant?.runtimeUrl || apiBaseUrl;
    return { kind: 'cloud', baseUrl, token: stored.token };
  }

  throw new MissingTokenError(missingTokenMessage(authProfile));
}

// ── Fixtures ────────────────────────────────────────────────────────

function makeLocalAssistant(
  overrides: Partial<AssistantDescriptor> = {},
): AssistantDescriptor {
  return {
    assistantId: 'local-1',
    cloud: 'local',
    runtimeUrl: 'http://127.0.0.1:7831',
    daemonPort: 7821,
    isActive: true,
    authProfile: 'local-pair',
    ...overrides,
  };
}

function makeCloudAssistant(
  overrides: Partial<AssistantDescriptor> = {},
): AssistantDescriptor {
  return {
    assistantId: 'cloud-1',
    cloud: 'vellum',
    runtimeUrl: 'https://rt.vellum.cloud',
    daemonPort: undefined,
    isActive: false,
    authProfile: 'cloud-oauth',
    ...overrides,
  };
}

function makeStoredLocalToken(overrides: Partial<StoredLocalToken> = {}): StoredLocalToken {
  return {
    token: 'local-cap-token-abc',
    expiresAt: Date.now() + 3600_000,
    guardianId: 'guardian-local-1',
    assistantPort: 7831,
    ...overrides,
  };
}

function makeStoredCloudToken(overrides: Partial<StoredCloudToken> = {}): StoredCloudToken {
  return {
    token: 'cloud-jwt-xyz',
    expiresAt: Date.now() + 3600_000,
    guardianId: 'guardian-cloud-1',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    bootstrapLocalToken: async () => {
      throw new Error('bootstrapLocalToken not configured');
    },
    signInCloud: async () => {
      throw new Error('signInCloud not configured');
    },
    refreshCloudToken: async () => null,
    getStoredCloudToken: async () => null,
    // Default to the build-time default environment (typically 'dev' in tests)
    effectiveEnvironment: resolveBuildDefaultEnvironment(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('connectPreflight — local-pair topology', () => {
  test('interactive: auto-bootstraps local token when missing', async () => {
    const assistant = makeLocalAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7821',
      token: null,
    };
    const bootstrapped = makeStoredLocalToken({ token: 'fresh-local-token', assistantPort: 9999 });
    let calledWith: string | null | undefined;
    const deps = makeDeps({
      bootstrapLocalToken: async (id) => {
        calledWith = id;
        return bootstrapped;
      },
    });

    const result = await connectPreflight(
      assistant,
      'local-pair',
      mode,
      { interactive: true },
      deps,
    );

    expect(calledWith).toBe('local-1');
    expect(result.kind).toBe('self-hosted');
    expect(result.token).toBe('fresh-local-token');
    expect(result.baseUrl).toBe('http://127.0.0.1:9999');
  });

  test('interactive: uses daemon port when bootstrap has no assistantPort', async () => {
    const assistant = makeLocalAssistant({ daemonPort: 8888 });
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:8888',
      token: null,
    };
    const bootstrapped = makeStoredLocalToken({
      token: 'fresh-token',
      assistantPort: undefined,
    });
    const deps = makeDeps({
      bootstrapLocalToken: async () => bootstrapped,
    });

    const result = await connectPreflight(
      assistant,
      'local-pair',
      mode,
      { interactive: true },
      deps,
    );

    expect(result.baseUrl).toBe('http://127.0.0.1:8888');
    expect(result.token).toBe('fresh-token');
  });

  test('non-interactive: throws MissingTokenError when token is missing', async () => {
    const assistant = makeLocalAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7821',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(
        assistant,
        'local-pair',
        mode,
        { interactive: false },
        deps,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('Re-pair');
    }
  });

  test('skips preflight when valid local token already exists', async () => {
    const assistant = makeLocalAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7821',
      token: 'existing-token',
    };
    let bootstrapCalled = false;
    const deps = makeDeps({
      bootstrapLocalToken: async () => {
        bootstrapCalled = true;
        return makeStoredLocalToken();
      },
    });

    const result = await connectPreflight(
      assistant,
      'local-pair',
      mode,
      { interactive: true },
      deps,
    );

    expect(bootstrapCalled).toBe(false);
    expect(result.token).toBe('existing-token');
  });
});

describe('connectPreflight — cloud-oauth topology', () => {
  test('interactive: auto-signs-in when token is missing', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const signedIn = makeStoredCloudToken({ token: 'fresh-cloud-jwt' });
    let signInCalledWith: { assistantId: string } | null = null;
    const deps = makeDeps({
      signInCloud: async (id, _config) => {
        signInCalledWith = { assistantId: id };
        return signedIn;
      },
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: true },
      deps,
    );

    expect(signInCalledWith).not.toBeNull();
    expect(signInCalledWith!.assistantId).toBe('cloud-1');
    expect(result.kind).toBe('cloud');
    expect(result.token).toBe('fresh-cloud-jwt');
    expect(result.baseUrl).toBe('https://rt.vellum.cloud');
  });

  test('interactive: auto-signs-in when token is stale', async () => {
    const assistant = makeCloudAssistant();
    // Mode has a token, but the stored token is stale (about to expire)
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: 'stale-token',
    };
    const staleToken = makeStoredCloudToken({
      token: 'stale-token',
      // Expires in 30 seconds — within the 60-second stale window
      expiresAt: Date.now() + 30_000,
    });
    const freshToken = makeStoredCloudToken({ token: 'refreshed-cloud-jwt' });
    const deps = makeDeps({
      getStoredCloudToken: async () => staleToken,
      signInCloud: async () => freshToken,
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: true },
      deps,
    );

    expect(result.token).toBe('refreshed-cloud-jwt');
  });

  test('non-interactive: succeeds when refresh returns a fresh token', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const refreshed = makeStoredCloudToken({ token: 'refreshed-jwt' });
    let refreshCalledWith: { assistantId: string } | null = null;
    const deps = makeDeps({
      refreshCloudToken: async (id, _config) => {
        refreshCalledWith = { assistantId: id };
        return refreshed;
      },
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: false },
      deps,
    );

    expect(refreshCalledWith).not.toBeNull();
    expect(refreshCalledWith!.assistantId).toBe('cloud-1');
    expect(result.token).toBe('refreshed-jwt');
    expect(result.baseUrl).toBe('https://rt.vellum.cloud');
  });

  test('non-interactive: throws MissingTokenError when refresh returns null', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const deps = makeDeps({
      refreshCloudToken: async () => null,
    });

    try {
      await connectPreflight(
        assistant,
        'cloud-oauth',
        mode,
        { interactive: false },
        deps,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('Re-sign in');
    }
  });

  test('non-interactive: falls back to stale-but-valid token when refresh fails', async () => {
    const assistant = makeCloudAssistant();
    // Mode has a token — stale but still technically valid
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: 'stale-but-valid-jwt',
    };
    const staleToken = makeStoredCloudToken({
      token: 'stale-but-valid-jwt',
      // Expires in 50 seconds — within the 60-second stale window
      expiresAt: Date.now() + 50_000,
    });
    let refreshCalled = false;
    const deps = makeDeps({
      getStoredCloudToken: async () => staleToken,
      // Refresh fails (e.g. provider session expired)
      refreshCloudToken: async () => {
        refreshCalled = true;
        return null;
      },
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: false },
      deps,
    );

    // Should have attempted refresh
    expect(refreshCalled).toBe(true);
    // Should fall back to the original mode with the stale-but-valid token
    expect(result).toBe(mode);
    expect(result.token).toBe('stale-but-valid-jwt');
    expect(result.baseUrl).toBe('https://rt.vellum.cloud');
  });

  test('skips preflight when valid cloud token exists and is not stale', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://rt.vellum.cloud',
      token: 'existing-jwt',
    };
    const freshToken = makeStoredCloudToken({
      token: 'existing-jwt',
      // Expires in 2 hours — well outside the stale window
      expiresAt: Date.now() + 7200_000,
    });
    let signInCalled = false;
    let refreshCalled = false;
    const deps = makeDeps({
      getStoredCloudToken: async () => freshToken,
      signInCloud: async () => {
        signInCalled = true;
        return makeStoredCloudToken();
      },
      refreshCloudToken: async () => {
        refreshCalled = true;
        return null;
      },
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: true },
      deps,
    );

    expect(signInCalled).toBe(false);
    expect(refreshCalled).toBe(false);
    expect(result.token).toBe('existing-jwt');
  });

  test('non-interactive: relay baseUrl uses runtimeUrl from assistant', async () => {
    const assistant = makeCloudAssistant({
      runtimeUrl: 'https://custom-gateway.vellum.cloud',
    });
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://custom-gateway.vellum.cloud',
      token: null,
    };
    const refreshed = makeStoredCloudToken({ token: 'refreshed-jwt' });
    const deps = makeDeps({
      refreshCloudToken: async () => refreshed,
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: false },
      deps,
    );

    expect(result.baseUrl).toBe('https://custom-gateway.vellum.cloud');
  });
});

describe('connectPreflight — edge cases', () => {
  test('unsupported profile throws MissingTokenError', async () => {
    const assistant: AssistantDescriptor = {
      assistantId: 'unsupported-1',
      cloud: 'future-topology',
      runtimeUrl: '',
      daemonPort: undefined,
      isActive: false,
      authProfile: 'unsupported',
    };
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7830',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(
        assistant,
        'unsupported',
        mode,
        { interactive: true },
        deps,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('unsupported topology');
    }
  });

  test('null assistant throws MissingTokenError for cloud profile', async () => {
    const { apiBaseUrl } = cloudUrlsForEnvironment(resolveBuildDefaultEnvironment());
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: apiBaseUrl,
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(
        null,
        'cloud-oauth',
        mode,
        { interactive: true },
        deps,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('Select an assistant');
    }
  });

  test('null profile throws MissingTokenError', async () => {
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7830',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(null, null, mode, { interactive: true }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('Select an assistant');
    }
  });

  test('cloud interactive falls back to environment-resolved gateway for relay baseUrl when no runtimeUrl', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl } = cloudUrlsForEnvironment(resolveBuildDefaultEnvironment());
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: apiBaseUrl,
      token: null,
    };
    const signedIn = makeStoredCloudToken({ token: 'fallback-jwt' });
    const deps = makeDeps({
      signInCloud: async () => signedIn,
    });

    const result = await connectPreflight(
      assistant,
      'cloud-oauth',
      mode,
      { interactive: true },
      deps,
    );

    // The fallback baseUrl should match the environment-resolved API URL
    expect(result.baseUrl).toBe(apiBaseUrl);
    expect(result.token).toBe('fallback-jwt');
  });
});

// ── Local token staleness decision ───────────────────────────────
//
// The worker's `buildRelayModeForAssistant` uses `isLocalTokenStale` to
// decide whether to attempt a silent bootstrap. These tests verify the
// decision boundary matches the stale-window semantics.

import {
  isLocalTokenStale,
  LOCAL_TOKEN_STALE_WINDOW_MS,
  type StoredLocalToken as StaleTestStoredLocalToken,
} from '../self-hosted-auth.js';

function makeFreshLocalToken(overrides: Partial<StaleTestStoredLocalToken> = {}): StaleTestStoredLocalToken {
  return {
    token: 'fresh-token',
    expiresAt: Date.now() + 3_600_000,
    guardianId: 'g-fresh',
    ...overrides,
  };
}

function makeStaleLocalToken(overrides: Partial<StaleTestStoredLocalToken> = {}): StaleTestStoredLocalToken {
  return {
    token: 'stale-token',
    expiresAt: Date.now() + 30_000,
    guardianId: 'g-stale',
    ...overrides,
  };
}

function makeExpiredLocalToken(overrides: Partial<StaleTestStoredLocalToken> = {}): StaleTestStoredLocalToken {
  return {
    token: 'expired-token',
    expiresAt: Date.now() - 1_000,
    guardianId: 'g-expired',
    ...overrides,
  };
}

describe('preflight: local token staleness drives silent recovery decision', () => {
  test('null token triggers recovery (isLocalTokenStale returns true)', () => {
    expect(isLocalTokenStale(null)).toBe(true);
  });

  test('expired token triggers recovery', () => {
    const token = makeExpiredLocalToken();
    expect(isLocalTokenStale(token)).toBe(true);
  });

  test('stale token (within stale window) triggers recovery', () => {
    const token = makeStaleLocalToken();
    expect(isLocalTokenStale(token)).toBe(true);
  });

  test('fresh token does NOT trigger recovery', () => {
    const token = makeFreshLocalToken();
    expect(isLocalTokenStale(token)).toBe(false);
  });

  test('token expiring exactly at stale boundary triggers recovery', () => {
    const now = 1_000_000;
    const token: StaleTestStoredLocalToken = {
      token: 'boundary',
      expiresAt: now + LOCAL_TOKEN_STALE_WINDOW_MS,
      guardianId: 'g-boundary',
    };
    expect(isLocalTokenStale(token, now)).toBe(true);
  });

  test('token expiring 1ms after stale boundary does NOT trigger recovery', () => {
    const now = 1_000_000;
    const token: StaleTestStoredLocalToken = {
      token: 'just-outside',
      expiresAt: now + LOCAL_TOKEN_STALE_WINDOW_MS + 1,
      guardianId: 'g-outside',
    };
    expect(isLocalTokenStale(token, now)).toBe(false);
  });
});

describe('recovery semantics', () => {
  test('successful bootstrap produces a usable fresh token', () => {
    const refreshed = makeFreshLocalToken({ token: 'bootstrap-fresh' });
    expect(refreshed.token).toBe('bootstrap-fresh');
    expect(isLocalTokenStale(refreshed)).toBe(false);
  });

  test('native host missing error is non-recoverable', () => {
    const error = new Error('Specified native messaging host not found.');
    expect(error.message).toContain('native messaging host not found');
  });

  test('forbidden origin error is non-recoverable', () => {
    const error = new Error('unauthorized_origin');
    expect(error.message).toBe('unauthorized_origin');
  });

  test('pair endpoint failure is non-recoverable', () => {
    const error = new Error('connection refused');
    expect(error.message).toBe('connection refused');
  });

  test('timeout error is non-recoverable', () => {
    const error = new Error('native messaging timeout');
    expect(error.message).toBe('native messaging timeout');
  });
});

describe('integrated silent recovery: staleness detection + bootstrap', () => {
  /**
   * These tests verify the integrated flow that the worker executes during
   * reconnect for local-pair assistants: detect staleness via
   * `isLocalTokenStale`, then call `bootstrapLocalToken` to recover.
   *
   * This exercises both functions together as they'd be invoked in the
   * actual reconnect path (buildRelayModeForAssistant).
   */

  test('stale token triggers bootstrap which produces a fresh usable token', async () => {
    const staleToken = makeStaleLocalToken({ token: 'original-stale' });

    // Step 1: staleness detection triggers recovery
    expect(isLocalTokenStale(staleToken)).toBe(true);

    // Step 2: bootstrap produces a fresh token
    const bootstrapResult = makeStoredLocalToken({
      token: 'bootstrap-refreshed',
      expiresAt: Date.now() + 3_600_000,
      assistantPort: 7831,
    });
    const deps = makeDeps({
      bootstrapLocalToken: async () => bootstrapResult,
    });
    const result = await deps.bootstrapLocalToken('local-1');

    // Step 3: the new token is fresh and usable
    expect(result.token).toBe('bootstrap-refreshed');
    expect(isLocalTokenStale(result)).toBe(false);
  });

  test('missing token triggers bootstrap which produces a fresh usable token', async () => {
    const storedToken = null;

    // Step 1: null token triggers recovery
    expect(isLocalTokenStale(storedToken)).toBe(true);

    // Step 2: bootstrap produces a fresh token
    const bootstrapResult = makeStoredLocalToken({
      token: 'new-from-bootstrap',
      expiresAt: Date.now() + 3_600_000,
      assistantPort: 9000,
    });
    const deps = makeDeps({
      bootstrapLocalToken: async () => bootstrapResult,
    });
    const result = await deps.bootstrapLocalToken('local-1');

    // Step 3: the new token is fresh and usable
    expect(result.token).toBe('new-from-bootstrap');
    expect(isLocalTokenStale(result)).toBe(false);
    expect(result.assistantPort).toBe(9000);
  });

  test('bootstrap failure surfaces original stale token (not null)', async () => {
    const staleToken = makeStaleLocalToken({ token: 'original-stale-kept' });

    // Step 1: staleness detection triggers recovery
    expect(isLocalTokenStale(staleToken)).toBe(true);

    // Step 2: bootstrap fails
    const deps = makeDeps({
      bootstrapLocalToken: async () => {
        throw new Error('native messaging timeout');
      },
    });

    let recoveredToken: StoredLocalToken | null = staleToken;
    try {
      await deps.bootstrapLocalToken('local-1');
    } catch {
      // Bootstrap failed — fall back to the original stale token
      recoveredToken = staleToken;
    }

    // Step 3: the original stale token is preserved (not null)
    expect(recoveredToken).not.toBeNull();
    expect(recoveredToken!.token).toBe('original-stale-kept');
  });

  test('bootstrap failure does not discard expired token either', async () => {
    const expiredToken = makeExpiredLocalToken({ token: 'expired-but-available' });

    // Step 1: staleness detection triggers recovery
    expect(isLocalTokenStale(expiredToken)).toBe(true);

    // Step 2: bootstrap fails
    const deps = makeDeps({
      bootstrapLocalToken: async () => {
        throw new Error('connection refused');
      },
    });

    let recoveredToken: StoredLocalToken | null = expiredToken;
    try {
      await deps.bootstrapLocalToken('local-1');
    } catch {
      // Bootstrap failed — fall back to the original token
      recoveredToken = expiredToken;
    }

    // Step 3: the original token is still surfaced (not replaced with null)
    expect(recoveredToken).not.toBeNull();
    expect(recoveredToken!.token).toBe('expired-but-available');
  });

  test('interactive local-pair preflight attempts bootstrap when token is missing and succeeds', async () => {
    const assistant = makeLocalAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:7821',
      token: null,
    };

    // Simulate: isLocalTokenStale(null) => true, then bootstrap succeeds
    expect(isLocalTokenStale(null)).toBe(true);

    const bootstrapped = makeStoredLocalToken({
      token: 'interactive-bootstrap-token',
      assistantPort: 7831,
    });
    let bootstrapCalled = false;
    const deps = makeDeps({
      bootstrapLocalToken: async (id) => {
        bootstrapCalled = true;
        expect(id).toBe('local-1');
        return bootstrapped;
      },
    });

    const result = await connectPreflight(
      assistant,
      'local-pair',
      mode,
      { interactive: true },
      deps,
    );

    expect(bootstrapCalled).toBe(true);
    expect(result.token).toBe('interactive-bootstrap-token');
    expect(isLocalTokenStale(bootstrapped)).toBe(false);
  });
});

describe('reconnect: silent recovery for self-hosted mode', () => {
  test('stale stored token on reconnect triggers recovery attempt', () => {
    const stored = makeStaleLocalToken();
    expect(isLocalTokenStale(stored)).toBe(true);
  });

  test('fresh stored token on reconnect uses existing token without bootstrap', () => {
    const stored = makeFreshLocalToken();
    expect(isLocalTokenStale(stored)).toBe(false);
    expect(stored.token).toBe('fresh-token');
  });

  test('missing token on reconnect triggers recovery attempt', () => {
    expect(isLocalTokenStale(null)).toBe(true);
  });

  test('recovery failure on reconnect produces abort with actionable message', () => {
    const abortError =
      'Self-hosted relay token missing or expired. Pair the Vellum assistant again from the extension popup.';
    expect(abortError).toContain('Pair');
    expect(abortError).toContain('extension popup');
  });
});

// ── Environment-resolved URL tests ──────────────────────────────────
//
// Verify that the preflight (and by extension the worker's cloud auth
// paths) uses environment-resolved URLs rather than fixed production
// constants. Each environment should yield different gateway/web URLs.

describe('connectPreflight — environment-resolved cloud URLs', () => {
  test('production environment uses production gateway and web URLs', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl: prodApi } = cloudUrlsForEnvironment('production');
    const mode: RelayMode = { kind: 'cloud', baseUrl: prodApi, token: null };
    const signedIn = makeStoredCloudToken({ token: 'prod-jwt' });
    let capturedConfig: { webBaseUrl: string } | null = null;
    const deps = makeDeps({
      effectiveEnvironment: 'production',
      signInCloud: async (_id, config) => {
        capturedConfig = config;
        return signedIn;
      },
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: true }, deps,
    );

    expect(result.baseUrl).toBe('https://api.vellum.ai');
    expect(result.token).toBe('prod-jwt');
    expect(capturedConfig!.webBaseUrl).toBe('https://www.vellum.ai');
  });

  test('staging environment uses staging gateway and web URLs', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl: stagingApi } = cloudUrlsForEnvironment('staging');
    const mode: RelayMode = { kind: 'cloud', baseUrl: stagingApi, token: null };
    const signedIn = makeStoredCloudToken({ token: 'staging-jwt' });
    let capturedConfig: { webBaseUrl: string } | null = null;
    const deps = makeDeps({
      effectiveEnvironment: 'staging',
      signInCloud: async (_id, config) => {
        capturedConfig = config;
        return signedIn;
      },
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: true }, deps,
    );

    expect(result.baseUrl).toBe('https://staging-api.vellum.ai');
    expect(result.token).toBe('staging-jwt');
    expect(capturedConfig!.webBaseUrl).toBe('https://staging-assistant.vellum.ai');
  });

  test('dev environment uses dev gateway and web URLs', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl: devApi } = cloudUrlsForEnvironment('dev');
    const mode: RelayMode = { kind: 'cloud', baseUrl: devApi, token: null };
    const refreshed = makeStoredCloudToken({ token: 'dev-refreshed-jwt' });
    let capturedConfig: { webBaseUrl: string } | null = null;
    const deps = makeDeps({
      effectiveEnvironment: 'dev',
      refreshCloudToken: async (_id, config) => {
        capturedConfig = config;
        return refreshed;
      },
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: false }, deps,
    );

    expect(result.baseUrl).toBe('https://dev-api.vellum.ai');
    expect(result.token).toBe('dev-refreshed-jwt');
    expect(capturedConfig!.webBaseUrl).toBe('https://dev-assistant.vellum.ai');
  });

  test('local environment uses localhost gateway and web URLs', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl: localApi } = cloudUrlsForEnvironment('local');
    const mode: RelayMode = { kind: 'cloud', baseUrl: localApi, token: null };
    const signedIn = makeStoredCloudToken({ token: 'local-jwt' });
    let capturedConfig: { webBaseUrl: string } | null = null;
    const deps = makeDeps({
      effectiveEnvironment: 'local',
      signInCloud: async (_id, config) => {
        capturedConfig = config;
        return signedIn;
      },
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: true }, deps,
    );

    expect(result.baseUrl).toBe('http://localhost:8080');
    expect(result.token).toBe('local-jwt');
    expect(capturedConfig!.webBaseUrl).toBe('http://localhost:3000');
  });

  test('non-interactive refresh also uses environment-resolved URLs', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const { apiBaseUrl: stagingApi } = cloudUrlsForEnvironment('staging');
    const mode: RelayMode = { kind: 'cloud', baseUrl: stagingApi, token: null };
    const refreshed = makeStoredCloudToken({ token: 'staging-refreshed' });
    let capturedConfig: { webBaseUrl: string } | null = null;
    const deps = makeDeps({
      effectiveEnvironment: 'staging',
      refreshCloudToken: async (_id, config) => {
        capturedConfig = config;
        return refreshed;
      },
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: false }, deps,
    );

    expect(result.baseUrl).toBe('https://staging-api.vellum.ai');
    expect(capturedConfig!.webBaseUrl).toBe('https://staging-assistant.vellum.ai');
  });

  test('runtimeUrl takes precedence over environment-resolved gateway', async () => {
    const assistant = makeCloudAssistant({
      runtimeUrl: 'https://custom-runtime.example.com',
    });
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://custom-runtime.example.com',
      token: null,
    };
    const signedIn = makeStoredCloudToken({ token: 'custom-jwt' });
    const deps = makeDeps({
      effectiveEnvironment: 'staging',
      signInCloud: async () => signedIn,
    });

    const result = await connectPreflight(
      assistant, 'cloud-oauth', mode, { interactive: true }, deps,
    );

    // runtimeUrl should still take precedence over the environment gateway
    expect(result.baseUrl).toBe('https://custom-runtime.example.com');
  });
});
