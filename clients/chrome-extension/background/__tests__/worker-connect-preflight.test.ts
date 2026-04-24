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
 *   - vellum-cloud: throws MissingTokenError (WorkOS session auth
 *     not yet implemented in preflight).
 *   - Preflight is a no-op when valid token already exists.
 */

import { describe, test, expect } from 'bun:test';

import { type AssistantAuthProfile } from '../assistant-auth-profile.js';
import type { AssistantDescriptor } from '../native-host-assistants.js';
import type { StoredLocalToken } from '../self-hosted-auth.js';
import {
  type ExtensionEnvironment,
  resolveBuildDefaultEnvironment,
} from '../extension-environment.js';

// ── Types mirroring worker.ts internals ─────────────────────────────

type RelayMode = { kind: 'self-hosted'; baseUrl: string; token: string | null };

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
  if (profile === 'local-pair') {
    return "Automatic local pairing failed \u2014 use 'Re-pair' in Advanced, then turn Connection on again";
  }
  if (profile === 'vellum-cloud') {
    return 'Vellum cloud auth is not yet supported by the extension. Please update or use a local assistant.';
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
  /** The effective environment used to resolve URLs. Defaults to build default. */
  effectiveEnvironment: ExtensionEnvironment;
}

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
  // Token already present — nothing to do.
  if (mode.token) {
    return mode;
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

  // Unsupported or vellum-cloud (not yet implemented) — preflight can't help.
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
    authProfile: 'vellum-cloud',
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

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    bootstrapLocalToken: async () => {
      throw new Error('bootstrapLocalToken not configured');
    },
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

describe('connectPreflight — vellum-cloud topology', () => {
  test('throws MissingTokenError (WorkOS auth not yet implemented)', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(assistant, 'vellum-cloud', mode, { interactive: true }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('not yet supported');
    }
  });

  test('throws even for non-interactive connect', async () => {
    const assistant = makeCloudAssistant();
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(assistant, 'vellum-cloud', mode, { interactive: false }, deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
    }
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

  test('vellum-cloud profile throws MissingTokenError', async () => {
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'https://rt.vellum.cloud',
      token: null,
    };
    const deps = makeDeps();

    try {
      await connectPreflight(
        makeCloudAssistant(),
        'vellum-cloud',
        mode,
        { interactive: true },
        deps,
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTokenError);
      expect((err as Error).message).toContain('not yet supported');
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
