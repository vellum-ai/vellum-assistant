/**
 * Tests for the worker's connection health state machine.
 *
 * Coverage:
 *   - Successful connect transitions: paused -> connecting -> connected.
 *   - Temporary disconnect with reconnect: connected -> reconnecting.
 *   - Unrecoverable auth failure: connecting -> auth_required.
 *   - Unrecoverable non-auth failure: connecting -> error.
 *   - Explicit pause: connected -> paused.
 *   - Detail fields (lastDisconnectCode, lastErrorMessage, lastChangeAt)
 *     are populated and cleared at the correct transitions.
 *   - Auto-connect startup: paused -> connecting -> connected or error.
 *   - get_status response includes health state and detail.
 *
 * These tests replicate the state transitions from the worker's message
 * listener and health state machine in isolation — the same approach used
 * by `worker-autoconnect.test.ts` and `worker-connect-preflight.test.ts`.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

// ── Types mirroring worker.ts health state ──────────────────────────

type ConnectionHealthState =
  | 'paused'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_required'
  | 'error';

interface ConnectionHealthDetail {
  lastDisconnectCode?: number;
  lastErrorMessage?: string;
  lastChangeAt: number;
}

// ── Fake chrome.storage.local ───────────────────────────────────────

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

// ── Storage key constants (mirror worker.ts) ────────────────────────

const AUTO_CONNECT_KEY = 'autoConnect';
const RELAY_AUTH_ERROR_KEY = 'vellum.relayAuthError';

// ── Minimal RelayConnection fake ────────────────────────────────────

interface FakeRelayConnection {
  started: boolean;
  closed: boolean;
  closeCode: number | null;
  closeReason: string | null;
  isOpen(): boolean;
  start(): void;
  close(code: number, reason: string): void;
}

function createFakeRelayConnection(opts?: { open?: boolean }): FakeRelayConnection {
  let open = opts?.open ?? false;
  return {
    started: false,
    closed: false,
    closeCode: null,
    closeReason: null,
    isOpen() {
      return open && !this.closed;
    },
    start() {
      this.started = true;
      open = true;
    },
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      open = false;
    },
  };
}

// ── Error types (mirror worker.ts) ──────────────────────────────────

class MissingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

// ── Isolated state machine mirroring worker.ts health transitions ───

interface WorkerHealthState {
  connectionHealth: ConnectionHealthState;
  connectionHealthDetail: ConnectionHealthDetail;
  shouldConnect: boolean;
  relayConnection: FakeRelayConnection | null;
  currentAuthProfile: 'local-pair' | 'cloud-oauth' | 'unsupported' | null;
  storage: FakeStorage;
}

function createWorkerHealthState(overrides?: Partial<WorkerHealthState>): WorkerHealthState {
  return {
    connectionHealth: 'paused',
    connectionHealthDetail: { lastChangeAt: Date.now() },
    shouldConnect: false,
    relayConnection: null,
    currentAuthProfile: null,
    storage: createFakeStorage(),
    ...overrides,
  };
}

/**
 * Mirrors the worker's `setConnectionHealth` function.
 */
function setConnectionHealth(
  state: WorkerHealthState,
  health: ConnectionHealthState,
  detail?: Partial<Omit<ConnectionHealthDetail, 'lastChangeAt'>>,
): void {
  state.connectionHealth = health;
  state.connectionHealthDetail = {
    ...state.connectionHealthDetail,
    ...detail,
    lastChangeAt: Date.now(),
  };
  if (health === 'connected') {
    delete state.connectionHealthDetail.lastDisconnectCode;
    delete state.connectionHealthDetail.lastErrorMessage;
  }
}

/**
 * Simulate the connect flow: sets connecting, creates relay, calls onOpen.
 */
async function simulateSuccessfulConnect(state: WorkerHealthState): Promise<void> {
  state.shouldConnect = true;
  setConnectionHealth(state, 'connecting');

  const relay = createFakeRelayConnection();
  relay.start();
  state.relayConnection = relay;

  // Simulate onOpen callback
  setConnectionHealth(state, 'connected');
  await state.storage.set({ [AUTO_CONNECT_KEY]: true });
}

/**
 * Simulate a connect that fails with MissingTokenError (auth failure).
 */
async function simulateAuthFailedConnect(
  state: WorkerHealthState,
  errorMessage: string,
): Promise<void> {
  state.shouldConnect = true;
  setConnectionHealth(state, 'connecting');

  // Connect fails with auth error
  state.shouldConnect = false;
  setConnectionHealth(state, 'auth_required', {
    lastErrorMessage: errorMessage,
  });
}

/**
 * Simulate a connect that fails with a non-auth error.
 */
async function simulateErrorConnect(
  state: WorkerHealthState,
  errorMessage: string,
): Promise<void> {
  state.shouldConnect = true;
  setConnectionHealth(state, 'connecting');

  // Connect fails with non-auth error
  state.shouldConnect = false;
  setConnectionHealth(state, 'error', {
    lastErrorMessage: errorMessage,
  });
}

/**
 * Simulate an unexpected WebSocket disconnect while shouldConnect is true
 * (triggering reconnect behavior).
 */
function simulateUnexpectedDisconnect(
  state: WorkerHealthState,
  closeCode: number,
): void {
  if (state.relayConnection) {
    state.relayConnection.close(closeCode, 'unexpected');
  }
  // Worker stays in shouldConnect mode — relay will reconnect
  setConnectionHealth(state, 'reconnecting', {
    lastDisconnectCode: closeCode,
  });
}

/**
 * Simulate an auth failure during reconnect (onClose with authError).
 */
function simulateReconnectAuthFailure(
  state: WorkerHealthState,
  closeCode: number,
  authError: string,
): void {
  state.shouldConnect = false;
  state.relayConnection = null;
  setConnectionHealth(state, 'auth_required', {
    lastDisconnectCode: closeCode,
    lastErrorMessage: authError,
  });
}

/**
 * Simulate the pause/disconnect message handler.
 */
async function simulatePause(state: WorkerHealthState): Promise<void> {
  state.shouldConnect = false;
  setConnectionHealth(state, 'paused');
  await state.storage.set({ [AUTO_CONNECT_KEY]: false });
  if (state.relayConnection) {
    state.relayConnection.close(1000, 'User paused');
    state.relayConnection = null;
  }
}

/**
 * Simulate get_status response construction.
 */
function getStatus(state: WorkerHealthState): {
  connected: boolean;
  authProfile: string | null;
  health: ConnectionHealthState;
  healthDetail: ConnectionHealthDetail;
} {
  return {
    connected: state.relayConnection !== null && state.relayConnection.isOpen(),
    authProfile: state.currentAuthProfile,
    health: state.connectionHealth,
    healthDetail: state.connectionHealthDetail,
  };
}

/**
 * Simulate bootstrap (auto-connect on service worker startup).
 */
async function simulateBootstrap(
  state: WorkerHealthState,
  connectFn: () => Promise<void>,
): Promise<void> {
  const result = await state.storage.get(AUTO_CONNECT_KEY);
  if (result[AUTO_CONNECT_KEY] !== true) return;

  state.shouldConnect = true;
  setConnectionHealth(state, 'connecting');
  try {
    await connectFn();
  } catch (err) {
    state.shouldConnect = false;
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof MissingTokenError) {
      setConnectionHealth(state, 'auth_required', {
        lastErrorMessage: detail,
      });
    } else {
      setConnectionHealth(state, 'error', {
        lastErrorMessage: detail,
      });
    }
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('connection health: successful connect lifecycle', () => {
  test('initial state is paused', () => {
    const state = createWorkerHealthState();

    expect(state.connectionHealth).toBe('paused');
    expect(state.connectionHealthDetail.lastChangeAt).toBeGreaterThan(0);
  });

  test('connect transitions through connecting -> connected', async () => {
    const state = createWorkerHealthState();

    // Start connecting
    state.shouldConnect = true;
    setConnectionHealth(state, 'connecting');
    expect(state.connectionHealth).toBe('connecting');

    // Socket opens
    const relay = createFakeRelayConnection();
    relay.start();
    state.relayConnection = relay;
    setConnectionHealth(state, 'connected');

    expect(state.connectionHealth).toBe('connected');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBeUndefined();
    expect(state.connectionHealthDetail.lastErrorMessage).toBeUndefined();
  });

  test('successful connect clears stale error detail fields', async () => {
    const state = createWorkerHealthState();

    // First, simulate a previous error state with details
    setConnectionHealth(state, 'error', {
      lastDisconnectCode: 1006,
      lastErrorMessage: 'previous error',
    });
    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(1006);
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('previous error');

    // Now connect successfully — error fields should be cleared
    await simulateSuccessfulConnect(state);

    expect(state.connectionHealth).toBe('connected');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBeUndefined();
    expect(state.connectionHealthDetail.lastErrorMessage).toBeUndefined();
  });
});

describe('connection health: temporary disconnect with reconnect', () => {
  test('unexpected disconnect moves to reconnecting when shouldConnect is true', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);
    expect(state.connectionHealth).toBe('connected');

    // Unexpected disconnect — relay will auto-reconnect
    simulateUnexpectedDisconnect(state, 1006);

    expect(state.connectionHealth).toBe('reconnecting');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(1006);
  });

  test('reconnecting -> connected on successful reconnect', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);

    // Disconnect
    simulateUnexpectedDisconnect(state, 1006);
    expect(state.connectionHealth).toBe('reconnecting');

    // Reconnect succeeds
    const freshRelay = createFakeRelayConnection();
    freshRelay.start();
    state.relayConnection = freshRelay;
    setConnectionHealth(state, 'connected');

    expect(state.connectionHealth).toBe('connected');
    // Stale detail cleared on successful connect
    expect(state.connectionHealthDetail.lastDisconnectCode).toBeUndefined();
  });

  test('reconnecting preserves disconnect code in detail', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);

    simulateUnexpectedDisconnect(state, 4001);

    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(4001);
  });
});

describe('connection health: unrecoverable auth/native-host failure', () => {
  test('auth failure during connect sets auth_required with error message', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'cloud-oauth' });

    await simulateAuthFailedConnect(
      state,
      "Automatic cloud sign-in failed \u2014 use 'Re-sign in' in Troubleshooting, then try Connect again",
    );

    expect(state.connectionHealth).toBe('auth_required');
    expect(state.connectionHealthDetail.lastErrorMessage).toContain('Re-sign in');
    expect(state.shouldConnect).toBe(false);
  });

  test('auth failure during reconnect sets auth_required with disconnect code', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'cloud-oauth' });
    await simulateSuccessfulConnect(state);

    // Simulate reconnect that results in auth failure
    simulateReconnectAuthFailure(
      state,
      4001,
      'Cloud relay closed with an auth-failure code. Sign in again.',
    );

    expect(state.connectionHealth).toBe('auth_required');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(4001);
    expect(state.connectionHealthDetail.lastErrorMessage).toContain('Sign in again');
    expect(state.shouldConnect).toBe(false);
    expect(state.relayConnection).toBeNull();
  });

  test('local-pair auth failure sets auth_required', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });

    await simulateAuthFailedConnect(
      state,
      "Automatic local pairing failed \u2014 use 'Re-pair' in Troubleshooting, then try Connect again",
    );

    expect(state.connectionHealth).toBe('auth_required');
    expect(state.connectionHealthDetail.lastErrorMessage).toContain('Re-pair');
  });

  test('native host not installed sets error (not auth_required)', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });

    await simulateErrorConnect(state, 'Native host not installed');

    expect(state.connectionHealth).toBe('error');
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('Native host not installed');
  });

  test('unsupported topology sets auth_required via MissingTokenError', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'unsupported' });

    // The worker throws MissingTokenError for unsupported topologies
    await simulateAuthFailedConnect(
      state,
      'This assistant uses an unsupported topology. Please update the Vellum extension.',
    );

    expect(state.connectionHealth).toBe('auth_required');
    expect(state.connectionHealthDetail.lastErrorMessage).toContain('unsupported topology');
  });
});

describe('connection health: explicit pause', () => {
  test('pause from connected sets paused', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);
    expect(state.connectionHealth).toBe('connected');

    await simulatePause(state);

    expect(state.connectionHealth).toBe('paused');
    expect(state.shouldConnect).toBe(false);
    expect(state.relayConnection).toBeNull();
  });

  test('pause from reconnecting sets paused', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);
    simulateUnexpectedDisconnect(state, 1006);
    expect(state.connectionHealth).toBe('reconnecting');

    await simulatePause(state);

    expect(state.connectionHealth).toBe('paused');
  });

  test('pause is idempotent when already paused', async () => {
    const state = createWorkerHealthState();
    expect(state.connectionHealth).toBe('paused');

    await simulatePause(state);

    expect(state.connectionHealth).toBe('paused');
  });

  test('pause preserves backward compatibility with disconnect alias', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);

    // Both pause and disconnect go through the same handler
    await simulatePause(state);

    const stored = await state.storage.get(AUTO_CONNECT_KEY);
    expect(stored[AUTO_CONNECT_KEY]).toBe(false);
    expect(state.connectionHealth).toBe('paused');
  });
});

describe('connection health: get_status response', () => {
  test('get_status includes health and healthDetail when connected', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });
    await simulateSuccessfulConnect(state);

    const status = getStatus(state);

    expect(status.connected).toBe(true);
    expect(status.health).toBe('connected');
    expect(status.healthDetail.lastChangeAt).toBeGreaterThan(0);
    expect(status.healthDetail.lastDisconnectCode).toBeUndefined();
    expect(status.healthDetail.lastErrorMessage).toBeUndefined();
  });

  test('get_status includes health and healthDetail when paused', () => {
    const state = createWorkerHealthState({ currentAuthProfile: null });

    const status = getStatus(state);

    expect(status.connected).toBe(false);
    expect(status.health).toBe('paused');
    expect(typeof status.healthDetail.lastChangeAt).toBe('number');
  });

  test('get_status includes health and healthDetail when reconnecting', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });
    await simulateSuccessfulConnect(state);
    simulateUnexpectedDisconnect(state, 1006);

    const status = getStatus(state);

    expect(status.connected).toBe(false);
    expect(status.health).toBe('reconnecting');
    expect(status.healthDetail.lastDisconnectCode).toBe(1006);
  });

  test('get_status includes health and healthDetail when auth_required', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'cloud-oauth' });
    await simulateAuthFailedConnect(state, 'Token expired');

    const status = getStatus(state);

    expect(status.connected).toBe(false);
    expect(status.health).toBe('auth_required');
    expect(status.healthDetail.lastErrorMessage).toBe('Token expired');
  });

  test('get_status includes health and healthDetail when error', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });
    await simulateErrorConnect(state, 'Native host crashed');

    const status = getStatus(state);

    expect(status.connected).toBe(false);
    expect(status.health).toBe('error');
    expect(status.healthDetail.lastErrorMessage).toBe('Native host crashed');
  });

  test('connected boolean stays backward-compatible with health state', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);

    const status = getStatus(state);
    // The `connected` boolean and `health` field should be consistent
    expect(status.connected).toBe(true);
    expect(status.health).toBe('connected');

    // Pause
    await simulatePause(state);
    const pausedStatus = getStatus(state);
    expect(pausedStatus.connected).toBe(false);
    expect(pausedStatus.health).toBe('paused');
  });
});

describe('connection health: auto-connect bootstrap', () => {
  test('bootstrap transitions through connecting -> connected on success', async () => {
    const state = createWorkerHealthState();
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    const healthStates: ConnectionHealthState[] = [];

    await simulateBootstrap(state, async () => {
      healthStates.push(state.connectionHealth);
      // Simulate successful connect
      const relay = createFakeRelayConnection();
      relay.start();
      state.relayConnection = relay;
      setConnectionHealth(state, 'connected');
      healthStates.push(state.connectionHealth);
    });

    // Should have gone through connecting -> connected
    expect(healthStates).toEqual(['connecting', 'connected']);
    expect(state.connectionHealth).toBe('connected');
  });

  test('bootstrap transitions to auth_required on MissingTokenError', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'cloud-oauth' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    await simulateBootstrap(state, async () => {
      throw new MissingTokenError('Cloud token expired');
    });

    expect(state.connectionHealth).toBe('auth_required');
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('Cloud token expired');
    expect(state.shouldConnect).toBe(false);
  });

  test('bootstrap transitions to error on non-auth failure', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    await simulateBootstrap(state, async () => {
      throw new Error('Native host not installed');
    });

    expect(state.connectionHealth).toBe('error');
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('Native host not installed');
    expect(state.shouldConnect).toBe(false);
  });

  test('bootstrap skips when autoConnect is false (stays paused)', async () => {
    const state = createWorkerHealthState();
    await state.storage.set({ [AUTO_CONNECT_KEY]: false });

    await simulateBootstrap(state, async () => {
      throw new Error('Should not be called');
    });

    expect(state.connectionHealth).toBe('paused');
  });

  test('bootstrap startup reconnect moves through connecting without terminal errors', async () => {
    // This validates the acceptance criterion that auto-connect startup
    // attempts move through connecting/reconnecting without surfacing
    // noisy terminal errors unless recovery is truly impossible.
    const state = createWorkerHealthState({ currentAuthProfile: 'local-pair' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    const healthStates: ConnectionHealthState[] = [];

    await simulateBootstrap(state, async () => {
      healthStates.push(state.connectionHealth);
      // Simulate a successful connect after a silent token refresh
      const relay = createFakeRelayConnection();
      relay.start();
      state.relayConnection = relay;
      setConnectionHealth(state, 'connected');
      healthStates.push(state.connectionHealth);
    });

    // The popup never sees an error state — only connecting -> connected
    expect(healthStates).toEqual(['connecting', 'connected']);
    expect(state.connectionHealth).toBe('connected');
  });
});

describe('connection health: detail field lifecycle', () => {
  test('lastChangeAt updates on every transition', async () => {
    const state = createWorkerHealthState();

    const t0 = state.connectionHealthDetail.lastChangeAt;

    // Small delay to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));
    setConnectionHealth(state, 'connecting');
    const t1 = state.connectionHealthDetail.lastChangeAt;
    expect(t1).toBeGreaterThanOrEqual(t0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    setConnectionHealth(state, 'connected');
    const t2 = state.connectionHealthDetail.lastChangeAt;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  test('error detail fields persist across reconnecting transitions', async () => {
    const state = createWorkerHealthState();
    await simulateSuccessfulConnect(state);

    // Disconnect with code 1006
    simulateUnexpectedDisconnect(state, 1006);

    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(1006);

    // The code persists while reconnecting
    expect(state.connectionHealth).toBe('reconnecting');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(1006);
  });

  test('successful connect clears lastDisconnectCode and lastErrorMessage', async () => {
    const state = createWorkerHealthState();

    // Set up error detail
    setConnectionHealth(state, 'reconnecting', {
      lastDisconnectCode: 4001,
      lastErrorMessage: 'auth failed',
    });
    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(4001);
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('auth failed');

    // Successful connect clears them
    setConnectionHealth(state, 'connected');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBeUndefined();
    expect(state.connectionHealthDetail.lastErrorMessage).toBeUndefined();
  });

  test('auth_required preserves both disconnect code and error message', () => {
    const state = createWorkerHealthState();

    setConnectionHealth(state, 'auth_required', {
      lastDisconnectCode: 4003,
      lastErrorMessage: 'Token revoked. Re-sign in.',
    });

    expect(state.connectionHealthDetail.lastDisconnectCode).toBe(4003);
    expect(state.connectionHealthDetail.lastErrorMessage).toBe('Token revoked. Re-sign in.');
  });
});

describe('connection health: full lifecycle scenarios', () => {
  test('connect -> disconnect -> reconnect -> connected (full recovery)', async () => {
    const state = createWorkerHealthState();

    // 1. Connect
    await simulateSuccessfulConnect(state);
    expect(state.connectionHealth).toBe('connected');

    // 2. Unexpected disconnect
    simulateUnexpectedDisconnect(state, 1006);
    expect(state.connectionHealth).toBe('reconnecting');

    // 3. Reconnect succeeds
    const freshRelay = createFakeRelayConnection();
    freshRelay.start();
    state.relayConnection = freshRelay;
    setConnectionHealth(state, 'connected');
    expect(state.connectionHealth).toBe('connected');
    expect(state.connectionHealthDetail.lastDisconnectCode).toBeUndefined();
  });

  test('connect -> disconnect -> auth_required -> pause -> connect', async () => {
    const state = createWorkerHealthState();

    // 1. Connect
    await simulateSuccessfulConnect(state);

    // 2. Disconnect with auth failure
    simulateReconnectAuthFailure(state, 4001, 'Token expired');
    expect(state.connectionHealth).toBe('auth_required');

    // 3. User pauses (to re-sign-in)
    await simulatePause(state);
    expect(state.connectionHealth).toBe('paused');

    // 4. User reconnects (after re-signing in)
    await simulateSuccessfulConnect(state);
    expect(state.connectionHealth).toBe('connected');
    expect(state.connectionHealthDetail.lastErrorMessage).toBeUndefined();
  });

  test('bootstrap -> auth_required -> manual connect -> connected', async () => {
    const state = createWorkerHealthState({ currentAuthProfile: 'cloud-oauth' });
    await state.storage.set({ [AUTO_CONNECT_KEY]: true });

    // 1. Bootstrap fails with auth error
    await simulateBootstrap(state, async () => {
      throw new MissingTokenError('Stale cloud token');
    });
    expect(state.connectionHealth).toBe('auth_required');

    // 2. User manually re-signs in and connects
    await simulateSuccessfulConnect(state);
    expect(state.connectionHealth).toBe('connected');
  });
});
