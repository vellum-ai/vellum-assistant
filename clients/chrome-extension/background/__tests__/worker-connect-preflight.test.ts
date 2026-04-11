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
 *   - Cloud non-interactive: fails when refresh also fails.
 *   - Preflight is a no-op when valid token already exists.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { resolveAuthProfile, type AssistantAuthProfile } from '../assistant-auth-profile.js';
import type { AssistantDescriptor } from '../native-host-assistants.js';
import { isCloudTokenStale, type StoredCloudToken } from '../cloud-auth.js';
import type { StoredLocalToken } from '../self-hosted-auth.js';

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
    return 'Sign in with Vellum (cloud) before connecting';
  }
  if (profile === 'local-pair') {
    return 'Pair the Vellum assistant (self-hosted) before connecting';
  }
  if (profile === 'unsupported') {
    return 'This assistant uses an unsupported topology. Please update the Vellum extension.';
  }
  return 'Select an assistant before connecting';
}

// ── Controllable fakes ──────────────────────────────────────────────

/**
 * Fake implementations for the auth functions the preflight calls.
 * Tests configure these per-case to control the preflight's behavior.
 */
interface PreflightDeps {
  bootstrapLocalToken: (assistantId: string | null) => Promise<StoredLocalToken>;
  signInCloud: (assistantId: string, config: { gatewayBaseUrl: string; clientId: string }) => Promise<StoredCloudToken>;
  refreshCloudToken: (assistantId: string, config: { gatewayBaseUrl: string; clientId: string }) => Promise<StoredCloudToken | null>;
  getStoredCloudToken: (assistantId: string) => Promise<StoredCloudToken | null>;
  getRelayPort: () => Promise<number>;
}

const CLOUD_GATEWAY_BASE_URL = 'https://api.vellum.ai';
const CLOUD_OAUTH_CLIENT_ID = 'vellum-chrome-extension';

/**
 * Standalone preflight implementation that mirrors the worker's
 * `connectPreflight` function but accepts injectable deps so tests
 * can control the auth function outcomes without mocking globals.
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
    const port = stored.assistantPort ?? assistant?.daemonPort ?? (await deps.getRelayPort());
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

    if (!options.interactive) {
      const gatewayBaseUrl = assistant?.runtimeUrl || CLOUD_GATEWAY_BASE_URL;
      const refreshed = await deps.refreshCloudToken(assistantId, {
        gatewayBaseUrl,
        clientId: CLOUD_OAUTH_CLIENT_ID,
      });
      if (refreshed) {
        const baseUrl = assistant?.runtimeUrl || CLOUD_GATEWAY_BASE_URL;
        return { kind: 'cloud', baseUrl, token: refreshed.token };
      }
      throw new MissingTokenError(missingTokenMessage('cloud-oauth'));
    }

    const gatewayBaseUrl = assistant?.runtimeUrl || CLOUD_GATEWAY_BASE_URL;
    const stored = await deps.signInCloud(assistantId, {
      gatewayBaseUrl,
      clientId: CLOUD_OAUTH_CLIENT_ID,
    });
    const baseUrl = assistant?.runtimeUrl || CLOUD_GATEWAY_BASE_URL;
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
    getRelayPort: async () => 7830,
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
      expect((err as Error).message).toContain('Pair');
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
    let signInCalledWith: { assistantId: string; gatewayBaseUrl: string } | null = null;
    const deps = makeDeps({
      signInCloud: async (id, config) => {
        signInCalledWith = { assistantId: id, gatewayBaseUrl: config.gatewayBaseUrl };
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
    expect(signInCalledWith!.gatewayBaseUrl).toBe('https://rt.vellum.cloud');
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
    let refreshCalledWith: { assistantId: string; gatewayBaseUrl: string } | null = null;
    const deps = makeDeps({
      refreshCloudToken: async (id, config) => {
        refreshCalledWith = { assistantId: id, gatewayBaseUrl: config.gatewayBaseUrl };
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
      expect((err as Error).message).toContain('Sign in');
    }
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

  test('non-interactive: uses runtimeUrl from assistant for refresh', async () => {
    const assistant = makeCloudAssistant({
      runtimeUrl: 'https://custom-gateway.vellum.cloud',
    });
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://custom-gateway.vellum.cloud',
      token: null,
    };
    const refreshed = makeStoredCloudToken({ token: 'refreshed-jwt' });
    let refreshCalledWith: { gatewayBaseUrl: string } | null = null;
    const deps = makeDeps({
      refreshCloudToken: async (_id, config) => {
        refreshCalledWith = { gatewayBaseUrl: config.gatewayBaseUrl };
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

    expect(refreshCalledWith!.gatewayBaseUrl).toBe('https://custom-gateway.vellum.cloud');
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
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: CLOUD_GATEWAY_BASE_URL,
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

  test('cloud interactive falls back to default gateway when no runtimeUrl', async () => {
    const assistant = makeCloudAssistant({ runtimeUrl: '' });
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: CLOUD_GATEWAY_BASE_URL,
      token: null,
    };
    const signedIn = makeStoredCloudToken({ token: 'fallback-jwt' });
    let signInCalledWith: { gatewayBaseUrl: string } | null = null;
    const deps = makeDeps({
      signInCloud: async (_id, config) => {
        signInCalledWith = { gatewayBaseUrl: config.gatewayBaseUrl };
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

    expect(signInCalledWith!.gatewayBaseUrl).toBe(CLOUD_GATEWAY_BASE_URL);
    expect(result.baseUrl).toBe(CLOUD_GATEWAY_BASE_URL);
    expect(result.token).toBe('fallback-jwt');
  });
});
